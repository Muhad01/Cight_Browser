/**
 * Cight Agent — popup.js
 *
 * Agent loop coordinator:
 *   1. User submits a task → POST /agent/start → get session_id
 *   2. Open SSE stream /agent/{id}/stream
 *   3. On "request_state" event → ask background for page state → POST /agent/{id}/state
 *   4. On "action" event → ask background to execute action → POST /agent/{id}/action_result
 *   5. On "done"/"error" → display result
 *
 * No Chrome restart. Works entirely in the current open Chrome window.
 */

const SERVER = "http://127.0.0.1:8000";

// ── DOM refs ───────────────────────────────────────────────────────────────────
const taskEl      = document.getElementById("task");
const modelEl     = document.getElementById("model");
const maxStepsEl  = document.getElementById("maxSteps");
const runBtn      = document.getElementById("runBtn");
const clearBtn    = document.getElementById("clearBtn");
const healthDot   = document.getElementById("health-dot");
const statusBar   = document.getElementById("statusBar");
const statusText  = document.getElementById("statusText");
const stepsLog    = document.getElementById("stepsLog");
const resultCard  = document.getElementById("resultCard");
const resultBadge = document.getElementById("resultBadge");
const resultMeta  = document.getElementById("resultMeta");
const resultText  = document.getElementById("resultText");

let activeSource   = null;
let activeSession  = null;
let stepCount      = 0;

// ── Persist inputs ─────────────────────────────────────────────────────────────
chrome.storage.local.get(["task", "model", "maxSteps", "contextMenuTask"], (saved) => {
  if (saved.contextMenuTask) {
    taskEl.value = saved.contextMenuTask;
    chrome.storage.local.remove("contextMenuTask");
  } else if (saved.task) {
    taskEl.value = saved.task;
  }
  if (saved.model)    modelEl.value    = saved.model;
  if (saved.maxSteps) maxStepsEl.value = saved.maxSteps;
});

taskEl.addEventListener("input",    () => chrome.storage.local.set({ task: taskEl.value }));
modelEl.addEventListener("change",  () => chrome.storage.local.set({ model: modelEl.value }));
maxStepsEl.addEventListener("change", () => chrome.storage.local.set({ maxSteps: maxStepsEl.value }));

// ── Health check ───────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const resp = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) throw new Error("non-200");
    healthDot.className = "ok";
    healthDot.title = "Server is running";
  } catch {
    healthDot.className = "error";
    healthDot.title = `Server not running at ${SERVER}\nRun: .venv\\Scripts\\uvicorn.exe agent_bridge.server:app --port 8000`;
  }
}
checkHealth();
setInterval(checkHealth, 10_000);

// ── UI helpers ─────────────────────────────────────────────────────────────────
function setRunning(on) {
  runBtn.disabled = on;
  runBtn.textContent = on ? "⏳ Running…" : "▶ Run task";
}

function showStatus(text) {
  statusBar.classList.add("visible");
  statusText.textContent = text;
}

function addLogLine(html) {
  stepsLog.classList.add("visible");
  const div = document.createElement("div");
  div.className = "step-line";
  div.innerHTML = html;
  stepsLog.appendChild(div);
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
    return;
  }
  resultBadge.className = "badge success";
  resultBadge.textContent = "done";
  resultMeta.textContent = `${steps} step${steps !== 1 ? "s" : ""}`;
  resultText.textContent = result || "(no result)";
}

function clearOutput() {
  statusBar.classList.remove("visible");
  stepsLog.classList.remove("visible");
  stepsLog.innerHTML = "";
  resultCard.classList.remove("visible");
  resultText.textContent = "";
  stepCount = 0;
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : (s || ""); }

// ── Stop active stream ─────────────────────────────────────────────────────────
function stopStream() {
  if (activeSource) { activeSource.close(); activeSource = null; }
  activeSession = null;
}

// ── Send page state to server ──────────────────────────────────────────────────
async function sendPageState(sessionId) {
  let state = { url: "", title: "", content: "" };
  try {
    state = await chrome.runtime.sendMessage({ type: "get_page_state" });
  } catch (e) {
    console.warn("get_page_state failed:", e);
  }
  await fetch(`${SERVER}/agent/${sessionId}/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
}

// ── Send action result to server ───────────────────────────────────────────────
async function sendActionResult(sessionId, result) {
  await fetch(`${SERVER}/agent/${sessionId}/action_result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  });
}

// ── Execute action in current tab ──────────────────────────────────────────────
async function doAction(action) {
  try {
    return await chrome.runtime.sendMessage({ type: "execute_action", action });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Main: start agent ──────────────────────────────────────────────────────────
runBtn.addEventListener("click", async () => {
  const task = taskEl.value.trim();
  if (!task) { showStatus("Enter a task first."); return; }

  stopStream();
  clearOutput();
  setRunning(true);
  showStatus("Starting agent…");

  const model    = modelEl.value;
  const maxSteps = parseInt(maxStepsEl.value, 10) || 25;

  // 1. Start session
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
    showResult({ success: false, message: `Cannot reach server at ${SERVER}.\n\nStart it with:\n.venv\\Scripts\\uvicorn.exe agent_bridge.server:app --port 8000` });
    return;
  }

  // 2. Open SSE stream
  const source = new EventSource(`${SERVER}/agent/${sessionId}/stream`);
  activeSource = source;

  source.onmessage = async (e) => {
    let event;
    try { event = JSON.parse(e.data); } catch { return; }

    switch (event.type) {
      case "start":
        showStatus(`Agent started — working in your current tab…`);
        break;

      case "request_state":
        showStatus(`Step ${event.step + 1} — reading page…`);
        await sendPageState(sessionId);
        break;

      case "thinking":
        showStatus(`Step ${event.step + 1} — thinking… (${truncate(event.url, 40)})`);
        break;

      case "action": {
        const a = event.action;
        stepCount++;
        const desc = a.description || a.url || a.text || a.result || a.key || a.direction || a.type;
        addLogLine(
          `<span class="n">Step ${event.step + 1}</span> ` +
          `<span style="color:#6c63ff">[${a.type}]</span> ` +
          `<span class="act">${truncate(String(desc), 90)}</span>`
        );
        showStatus(`Step ${event.step + 1} — executing ${a.type}…`);

        if (a.type !== "done" && a.type !== "fail") {
          const result = await doAction(a);
          await sendActionResult(sessionId, { success: result.success, error: result.error || null });
        }
        break;
      }

      case "step_error":
        addLogLine(`<span class="n">Step ${event.step + 1}</span> <span style="color:#ff5c72">⚠ ${truncate(event.message, 100)}</span>`);
        break;

      case "status":
        showStatus(event.message);
        break;

      case "done":
        source.close();
        activeSource = null;
        setRunning(false);
        showResult({ success: true, result: event.result, steps: event.steps });
        chrome.runtime.sendMessage({ type: "task_done", result: event.result, steps: event.steps });
        break;

      case "error":
        source.close();
        activeSource = null;
        setRunning(false);
        showResult({ success: false, message: event.message });
        break;
    }
  };

  source.onerror = () => {
    source.close();
    activeSource = null;
    setRunning(false);
    if (!resultCard.classList.contains("visible")) {
      showResult({ success: false, message: `Lost connection to server at ${SERVER}.` });
    }
  };
});

clearBtn.addEventListener("click", () => {
  stopStream();
  setRunning(false);
  clearOutput();
  statusBar.classList.remove("visible");
});
