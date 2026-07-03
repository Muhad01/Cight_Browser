/**
 * Cight Agent — sidepanel.js
 * Same agent-loop logic as popup.js, adapted for the full-height side panel.
 */

const SERVER = "http://127.0.0.1:8000";
const MAX_HISTORY = 10;

// ── DOM refs ───────────────────────────────────────────────────────────────────
const taskEl       = document.getElementById("task");
const modelEl      = document.getElementById("model");
const maxStepsEl   = document.getElementById("maxSteps");
const runBtn       = document.getElementById("runBtn");
const clearBtn     = document.getElementById("clearBtn");
const healthDot    = document.getElementById("health-dot");
const healthLabel  = document.getElementById("health-label");
const statusBar    = document.getElementById("statusBar");
const statusText   = document.getElementById("statusText");
const stepsLog     = document.getElementById("stepsLog");
const resultCard   = document.getElementById("resultCard");
const resultBadge  = document.getElementById("resultBadge");
const resultMeta   = document.getElementById("resultMeta");
const resultText   = document.getElementById("resultText");
const historySection  = document.getElementById("historySection");
const historyDivider  = document.getElementById("historyDivider");
const historyList     = document.getElementById("historyList");

let activeSource  = null;
let activeSession = null;

// ── Restore inputs ─────────────────────────────────────────────────────────────
chrome.storage.local.get(["task", "model", "maxSteps", "contextMenuTask", "taskHistory"], (saved) => {
  if (saved.contextMenuTask) {
    taskEl.value = saved.contextMenuTask;
    chrome.storage.local.remove("contextMenuTask");
  } else if (saved.task) {
    taskEl.value = saved.task;
  }
  if (saved.model)    modelEl.value    = saved.model;
  if (saved.maxSteps) maxStepsEl.value = saved.maxSteps;
  if (saved.taskHistory?.length) renderHistory(saved.taskHistory);
});

taskEl.addEventListener("input",    () => chrome.storage.local.set({ task: taskEl.value }));
modelEl.addEventListener("change",  () => chrome.storage.local.set({ model: modelEl.value }));
maxStepsEl.addEventListener("change", () => chrome.storage.local.set({ maxSteps: maxStepsEl.value }));

// ── Health check ───────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const r = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error();
    healthDot.className = "ok";
    healthLabel.textContent = "server ready";
  } catch {
    healthDot.className = "error";
    healthLabel.textContent = "server offline";
    healthDot.title = `Start: .venv\\Scripts\\uvicorn.exe agent_bridge.server:app --port 8000`;
  }
}
checkHealth();
setInterval(checkHealth, 10_000);

// ── UI helpers ─────────────────────────────────────────────────────────────────
function setRunning(on) {
  runBtn.disabled = on;
  runBtn.textContent = on ? "⏳  Running…" : "▶  Run task";
}

function showStatus(text) {
  statusBar.classList.add("visible");
  statusText.textContent = text;
}

function addStep(step, type, desc) {
  stepsLog.classList.add("visible");
  const el = document.createElement("div");
  el.className = "step-line";
  el.innerHTML =
    `<span class="n">Step ${step + 1}</span>` +
    `<span class="tag">${type}</span>` +
    `<span class="act">${truncate(String(desc || ""), 120)}</span>`;
  stepsLog.appendChild(el);
  stepsLog.scrollTop = stepsLog.scrollHeight;
}

function showResult({ success, result, steps, message }) {
  statusBar.classList.remove("visible");
  resultCard.classList.add("visible");
  if (!success) {
    resultBadge.className = "badge error";
    resultBadge.textContent = "error";
    resultMeta.textContent = "";
    resultText.textContent = message || "Unknown error";
  } else {
    resultBadge.className = "badge success";
    resultBadge.textContent = "done";
    resultMeta.textContent = `${steps} step${steps !== 1 ? "s" : ""}`;
    resultText.textContent = result || "(no result)";
  }
}

function clearOutput() {
  statusBar.classList.remove("visible");
  stepsLog.classList.remove("visible");
  stepsLog.innerHTML = "";
  resultCard.classList.remove("visible");
  resultText.textContent = "";
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ── History ────────────────────────────────────────────────────────────────────
function renderHistory(items) {
  if (!items?.length) return;
  historyList.innerHTML = "";
  items.forEach((item) => {
    const el = document.createElement("div");
    el.className = "history-item";
    el.innerHTML =
      `<div class="hi-task">${truncate(item.task, 80)}</div>` +
      `<div class="hi-meta">` +
        `<span class="hi-badge ${item.success ? "success" : "error"}">${item.success ? "done" : "error"}</span>` +
        `${item.steps ? item.steps + " steps · " : ""}${item.time}` +
      `</div>`;
    el.addEventListener("click", () => { taskEl.value = item.task; chrome.storage.local.set({ task: item.task }); });
    historyList.appendChild(el);
  });
  historySection.classList.add("visible");
  historyDivider.style.display = "";
}

function saveToHistory(entry) {
  chrome.storage.local.get(["taskHistory"], ({ taskHistory = [] }) => {
    const updated = [entry, ...taskHistory].slice(0, MAX_HISTORY);
    chrome.storage.local.set({ taskHistory: updated });
    renderHistory(updated);
  });
}

// ── Stop active stream ─────────────────────────────────────────────────────────
function stopStream() {
  if (activeSource) { activeSource.close(); activeSource = null; }
  activeSession = null;
}

// ── Agent bridge helpers ───────────────────────────────────────────────────────
async function sendPageState(sessionId) {
  let state = { url: "", title: "", content: "" };
  try { state = await chrome.runtime.sendMessage({ type: "get_page_state" }); } catch {}
  await fetch(`${SERVER}/agent/${sessionId}/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  }).catch(() => {});
}

async function sendActionResult(sessionId, result) {
  await fetch(`${SERVER}/agent/${sessionId}/action_result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  }).catch(() => {});
}

async function doAction(action) {
  try {
    return await chrome.runtime.sendMessage({ type: "execute_action", action });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Run ────────────────────────────────────────────────────────────────────────
runBtn.addEventListener("click", async () => {
  const task = taskEl.value.trim();
  if (!task) { showStatus("Enter a task first."); return; }

  stopStream();
  clearOutput();
  setRunning(true);
  showStatus("Starting agent…");

  const model    = modelEl.value;
  const maxSteps = parseInt(maxStepsEl.value, 10) || 25;
  const startTime = Date.now();

  // Start session
  let sessionId;
  try {
    const resp = await fetch(`${SERVER}/agent/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, model, max_steps: maxSteps }),
    });
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);
    ({ session_id: sessionId } = await resp.json());
    activeSession = sessionId;
  } catch (err) {
    setRunning(false);
    showResult({ success: false, message: `Cannot reach server at ${SERVER}.\n\nRun:\n.venv\\Scripts\\uvicorn.exe agent_bridge.server:app --port 8000` });
    return;
  }

  // Open SSE stream
  const source = new EventSource(`${SERVER}/agent/${sessionId}/stream`);
  activeSource = source;

  source.onmessage = async (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }

    switch (event.type) {
      case "start":
        showStatus("Agent active — working in your current tab…");
        break;

      case "request_state":
        showStatus(`Step ${event.step + 1} — reading page…`);
        await sendPageState(sessionId);
        break;

      case "thinking":
        showStatus(`Step ${event.step + 1} — deciding next action…`);
        break;

      case "action": {
        const a = event.action;
        const desc = a.description || a.url || a.text || a.result || a.key || a.direction || a.type;
        addStep(event.step, a.type, desc);
        showStatus(`Step ${event.step + 1} — executing ${a.type}…`);
        if (a.type !== "done" && a.type !== "fail") {
          const res = await doAction(a);
          await sendActionResult(sessionId, { success: res.success, error: res.error || null });
        }
        break;
      }

      case "step_error":
        addStep(event.step, "warn", event.message);
        break;

      case "status":
        showStatus(event.message);
        break;

      case "done": {
        source.close();
        activeSource = null;
        setRunning(false);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        showResult({ success: true, result: event.result, steps: event.steps });
        saveToHistory({ task, success: true, steps: event.steps, time: `${elapsed}s` });
        chrome.runtime.sendMessage({ type: "task_done", result: event.result, steps: event.steps });
        break;
      }

      case "error": {
        source.close();
        activeSource = null;
        setRunning(false);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        showResult({ success: false, message: event.message });
        saveToHistory({ task, success: false, time: `${elapsed}s` });
        break;
      }
    }
  };

  source.onerror = () => {
    source.close();
    activeSource = null;
    setRunning(false);
    if (!resultCard.classList.contains("visible")) {
      showResult({ success: false, message: `Lost connection to ${SERVER}.` });
    }
  };
});

clearBtn.addEventListener("click", () => {
  stopStream();
  setRunning(false);
  clearOutput();
  statusBar.classList.remove("visible");
});
