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
        // Wait for the page to finish loading
        await waitForTabLoad(tab.id);
        return { success: true };
      }

      case "click": {
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
        await sleep(600);
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

function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function check(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
      if (Date.now() > deadline) {
        chrome.tabs.onUpdated.removeListener(check);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(check);
    // Also resolve after timeout regardless
    setTimeout(resolve, timeoutMs);
  });
}


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
