/**
 * Cight Agent — background.js
 *
 * Handles all direct browser control on behalf of the agent:
 *   • getPageState()    → returns {url, title, content} of the active tab
 *   • executeAction()   → performs navigate / click / type / key / scroll / wait
 *
 * The side panel coordinates the agent loop by talking to the FastAPI server,
 * then forwarding requests here via chrome.runtime.sendMessage().
 */

// ── Open side panel on toolbar icon click ──────────────────────────────────────
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});  // API only available in Chrome 114+

const SERVER = "http://127.0.0.1:8000";

// ── Page state capture ─────────────────────────────────────────────────────────

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Inject a content script to extract a simplified, LLM-friendly page summary.
 * Returns visible interactive elements + first ~3000 chars of visible text.
 */
async function getPageContent(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function getText(el) {
          return (el.innerText || el.textContent || "").trim().slice(0, 80);
        }
        function getLabel(el) {
          if (el.ariaLabel) return el.ariaLabel;
          if (el.placeholder) return el.placeholder;
          if (el.title) return el.title;
          if (el.name) return el.name;
          return getText(el);
        }

        const lines = [];

        // --- Interactive elements ---
        const interactive = document.querySelectorAll(
          'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
        );
        const seen = new Set();
        interactive.forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return; // hidden
          const tag = el.tagName.toLowerCase();
          const label = getLabel(el) || "(no label)";
          if (seen.has(label)) return;
          seen.add(label);

          let selector = tag;
          if (el.id) selector = `#${el.id}`;
          else if (el.name) selector = `${tag}[name="${el.name}"]`;
          else if (el.className) selector = `${tag}.${el.className.trim().split(/\s+/)[0]}`;

          const type = el.type ? ` type="${el.type}"` : "";
          const href = el.href ? ` href="${el.href.slice(0, 60)}"` : "";
          lines.push(`[${selector}]${type}${href} → "${label.slice(0, 80)}"`);
        });

        // --- Visible body text (first 2000 chars) ---
        const bodyText = document.body?.innerText?.replace(/\s+/g, " ").trim().slice(0, 2000) || "";

        return `=== INTERACTIVE ELEMENTS ===\n${lines.slice(0, 60).join("\n")}\n\n=== PAGE TEXT ===\n${bodyText}`;
      },
    });
    return result || "(could not extract page content)";
  } catch (e) {
    return `(content extraction failed: ${e.message})`;
  }
}

async function getPageState() {
  const tab = await getActiveTab();
  if (!tab) return { url: "", title: "", content: "" };
  const content = await getPageContent(tab.id);
  return { url: tab.url || "", title: tab.title || "", content };
}


// ── Action execution ───────────────────────────────────────────────────────────

async function executeAction(action) {
  const tab = await getActiveTab();
  if (!tab) return { success: false, error: "No active tab" };

  try {
    switch (action.type) {

      case "navigate": {
        await chrome.tabs.update(tab.id, { url: action.url });
        // Wait for full page readiness: tab status + DOM stability
        await waitForPageReady(tab.id, { stabilityMs: 700, timeoutMs: 20000 });
        return { success: true };
      }

      case "click": {
        // Snapshot URL before click so we can detect a navigation
        const urlBefore = tab.url;

        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector) => {
            const el = document.querySelector(selector)
              || [...document.querySelectorAll("*")].find(
                  (e) => e.innerText?.trim() === selector || e.ariaLabel === selector
                );
            if (!el) return `Element not found: ${selector}`;
            el.click();
            return null;
          },
          args: [action.selector],
        });
        if (result) return { success: false, error: result };

        // Give the browser a moment to decide if this click triggers a navigation
        await sleep(400);
        const tabAfter = await chrome.tabs.get(tab.id).catch(() => null);
        const navigated = tabAfter && tabAfter.url !== urlBefore;

        if (navigated || tabAfter?.status !== "complete") {
          // Click caused a navigation — wait for full page readiness
          await waitForPageReady(tab.id, { stabilityMs: 700, timeoutMs: 20000 });
        } else {
          // Click was in-page (e.g. opening a dropdown) — just wait for DOM to settle
          await waitForDomStability(tab.id, 400, 5000);
        }
        return { success: true };
      }

      case "type": {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, text) => {
            const el = document.querySelector(selector);
            if (!el) return `Element not found: ${selector}`;
            el.focus();
            el.dispatchEvent(new Event("focus"));
            // Append to existing value
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, "value"
            )?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(el, (el.value || "") + text);
            } else {
              el.value = (el.value || "") + text;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return null;
          },
          args: [action.selector, action.text],
        });
        if (result) return { success: false, error: result };
        await sleep(300);
        return { success: true };
      }

      case "clear_and_type": {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, text) => {
            const el = document.querySelector(selector);
            if (!el) return `Element not found: ${selector}`;
            el.focus();
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
              window.HTMLInputElement.prototype, "value"
            )?.set || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
            if (nativeInputValueSetter) {
              nativeInputValueSetter.call(el, text);
            } else {
              el.value = text;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return null;
          },
          args: [action.selector, action.text],
        });
        if (result) return { success: false, error: result };
        await sleep(300);
        return { success: true };
      }

      case "key": {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (key) => {
            const el = document.activeElement || document.body;
            const keyMap = { Enter: 13, Tab: 9, Escape: 27, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Backspace: 8 };
            const code = keyMap[key] || 0;
            ["keydown", "keypress", "keyup"].forEach((type) => {
              el.dispatchEvent(new KeyboardEvent(type, { key, keyCode: code, bubbles: true }));
            });
          },
          args: [action.key],
        });
        await sleep(400);
        return { success: true };
      }

      case "scroll": {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (direction, pixels) => {
            window.scrollBy(0, direction === "down" ? pixels : -pixels);
          },
          args: [action.direction || "down", action.pixels || 400],
        });
        await sleep(300);
        return { success: true };
      }

      case "wait": {
        await sleep((action.seconds || 1) * 1000);
        return { success: true };
      }

      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * WAY 1: Wait until chrome.tabs reports status === "complete" for the tab.
 * This is a prerequisite for all other checks — the page must be loaded
 * before we can inject scripts into it.
 */
function waitForTabStatus(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    // Check if tab is already complete
    chrome.tabs.get(tabId, (tab) => {
      if (tab?.status === "complete") { resolve(); return; }
    });

    const timer = setTimeout(resolve, timeoutMs);
    function check(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(check);
  });
}

/**
 * WAY 2 + 3 combined: After tab status is "complete", inject a script that:
 *   - Polls document.readyState until "complete"          (Way 2)
 *   - Then watches MutationObserver for DOM stability     (Way 3)
 *     → resolves only after N ms with no DOM mutations
 * This correctly handles SPAs (YouTube, Gmail, etc.) that fake "complete"
 * while still hydrating the page with dynamic content.
 *
 * @param {number} tabId
 * @param {number} stabilityMs   - ms of DOM silence required (default 600ms)
 * @param {number} timeoutMs     - hard cap before giving up (default 10s)
 */
async function waitForDomStability(tabId, stabilityMs = 600, timeoutMs = 10000) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (stabilityMs, timeoutMs) => {
        return new Promise((resolve) => {
          const start = Date.now();
          let stabilityTimer = null;

          function reset() {
            clearTimeout(stabilityTimer);
            if (Date.now() - start > timeoutMs) { resolve("timeout"); return; }
            stabilityTimer = setTimeout(() => { observer.disconnect(); resolve("stable"); }, stabilityMs);
          }

          // First ensure readyState is complete
          function onReady() {
            const observer = new MutationObserver(reset);
            observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
            reset(); // start the stability clock
          }

          if (document.readyState === "complete") {
            onReady();
          } else {
            document.addEventListener("readystatechange", () => {
              if (document.readyState === "complete") onReady();
            }, { once: true });
          }
        });
      },
      args: [stabilityMs, timeoutMs],
    });
  } catch {
    // Script injection can fail on chrome:// or extension pages — just fall through
  }
}

/**
 * Full page-ready wait: tab status complete → DOM stability.
 * Used after every navigation or click that might trigger a page change.
 */
async function waitForPageReady(tabId, { stabilityMs = 600, timeoutMs = 15000 } = {}) {
  await waitForTabStatus(tabId, timeoutMs);
  // Brief pause before injecting — avoids race where tab reports "complete" but
  // hasn't committed the new document yet (common on fast navigations)
  await sleep(150);
  await waitForDomStability(tabId, stabilityMs, timeoutMs);
}

// Kept as alias for backward compat inside executeAction
const waitForTabLoad = (tabId, timeoutMs) => waitForPageReady(tabId, { timeoutMs });


// ── Message handler (from popup) ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "get_page_state") {
    getPageState().then(sendResponse);
    return true; // async
  }
  if (msg.type === "execute_action") {
    executeAction(msg.action).then(sendResponse);
    return true; // async
  }
  if (msg.type === "task_done") {
    chrome.notifications?.create({
      type: "basic",
      iconUrl: "icon128.png",
      title: `Cight — Done in ${msg.steps} step${msg.steps !== 1 ? "s" : ""}`,
      message: (msg.result || "").slice(0, 200),
    });
  }
});


// ── Context menu ───────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "cight-run-on-page",
    title: "Ask Cight agent to work on this page",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const task = info.selectionText?.trim()
    || `Summarize the main content of the current page (${tab.url})`;

  // Store the task so the side panel can pick it up
  await chrome.storage.local.set({ contextMenuTask: task });

  // Open the side panel
  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});
