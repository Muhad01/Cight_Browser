# Browser-Use + Chrome Extension: Full Implementation Guide

This guide walks through building a Chrome extension that drives a `browser-use` agent
against your **real Chrome profile** (cookies, sessions, saved passwords, extensions
intact), using a local FastAPI server as the bridge between the extension UI and the
agent process.

**Architecture (recommended combo: Approach 1 + Approach 3):**

```
Chrome Extension (popup/side panel)
        │  fetch("http://localhost:8000/run")
        ▼
FastAPI server (localhost:8000)
        │  Agent(task, llm) from browser-use
        ▼
browser-use Agent
        │  connect_over_cdp("http://localhost:9222")
        ▼
Your actual Chrome process (--remote-debugging-port=9222 --user-data-dir=<your profile>)
```

The extension never touches the browser automation directly — it just triggers tasks
and displays results. The heavy lifting happens in a Python process that attaches to
your already-running, already-logged-in Chrome via the Chrome DevTools Protocol (CDP).

---

## 0. Prerequisites

```bash
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn browser-use langchain-anthropic playwright
playwright install chromium   # not strictly needed since we attach to real Chrome, but browser-use expects it available
```

You'll also need an `ANTHROPIC_API_KEY` (or whichever LLM provider you use) set as an
environment variable.

---

## 1. Launch Chrome with a remote debugging port on your real profile

This is the step that makes "the agent literally acts as you" possible. You are **not**
launching a fresh, empty Chrome — you're exposing your existing profile's Chrome
process over CDP.

### Find your profile path

- **macOS:** `~/Library/Application Support/Google/Chrome/Default` (or `Profile 1`, etc. if you use multiple profiles — check `chrome://version` → "Profile Path")
- **Windows:** `%LOCALAPPDATA%\Google\Chrome\User Data\Default`
- **Linux:** `~/.config/google-chrome/Default`

### Important: close any already-running Chrome using that profile first

Chrome only allows **one process** to hold a lock on a given profile directory at a
time. If Chrome is already open with that profile, either:

- Quit Chrome entirely before running the command below, **or**
- Use a **copy** of your profile directory so your daily-driver Chrome stays open and
  untouched (safer — see "Profile copy" note below).

### macOS / Linux

```bash
# Quit all Chrome windows first, then:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="/Users/you/Library/Application Support/Google/Chrome/Default" \
  --no-first-run --no-default-browser-check
```

### Windows (PowerShell)

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="C:\Users\you\AppData\Local\Google\Chrome\User Data\Default" `
  --no-first-run --no-default-browser-check
```

### Verify it worked

Open `http://localhost:9222/json/version` in any browser — you should see JSON
describing the attached Chrome instance. If you get a connection refused error, Chrome
isn't listening on that port (usually because another Chrome process already owns the
profile lock).

### Safer variant: profile copy

If you don't want to close your daily Chrome, copy the profile once and point the
debug-launched Chrome at the copy. You lose live-session freshness (cookies won't
update after the copy) but you can keep using your main browser normally:

```bash
cp -R "/Users/you/Library/Application Support/Google/Chrome/Default" \
      "/Users/you/chrome-agent-profile"

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="/Users/you/chrome-agent-profile" \
  --no-first-run --no-default-browser-check
```

---

## 2. The FastAPI bridge server

Create `server.py`:

```python
# server.py
import asyncio
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from playwright.async_api import async_playwright
from browser_use import Agent
from langchain_anthropic import ChatAnthropic

CDP_URL = "http://localhost:9222"

# Keep a single Playwright + browser connection alive across requests
_playwright = None
_browser = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _playwright, _browser
    _playwright = await async_playwright().start()
    _browser = await _playwright.chromium.connect_over_cdp(CDP_URL)
    yield
    await _browser.close()
    await _playwright.stop()


app = FastAPI(lifespan=lifespan)

# Allow the extension (chrome-extension:// origin) to call this local server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],       # tighten this to your extension's ID in production
    allow_methods=["*"],
    allow_headers=["*"],
)


class RunRequest(BaseModel):
    task: str
    max_steps: int = 25


class RunResponse(BaseModel):
    result: str
    steps_taken: int


@app.post("/run", response_model=RunResponse)
async def run_task(payload: RunRequest):
    if _browser is None:
        raise HTTPException(500, "Browser connection not initialized")

    llm = ChatAnthropic(
        model="claude-sonnet-4-6",
        api_key=os.environ["ANTHROPIC_API_KEY"],
    )

    # browser-use's Agent can take an already-connected browser context
    context = _browser.contexts[0]  # your existing profile's context (cookies, sessions, etc.)

    agent = Agent(
        task=payload.task,
        llm=llm,
        browser_context=context,
    )

    history = await agent.run(max_steps=payload.max_steps)

    return RunResponse(
        result=str(history.final_result()),
        steps_taken=len(history.history),
    )


@app.get("/health")
async def health():
    return {"status": "ok", "connected": _browser is not None}
```

Run it:

```bash
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

> **Note on `browser_context`:** `browser-use`'s exact API for injecting an existing
> Playwright context has changed across versions. Check your installed version's docs
> (`python -c "import browser_use; print(browser_use.__version__)"`) — some versions
> expect a `Browser`/`BrowserConfig` object rather than a raw Playwright context. The
> pattern is the same either way: construct browser-use's browser wrapper *from* the
> CDP-attached Playwright browser instead of letting browser-use launch its own.

### If your browser-use version wants to own the CDP connection itself

Some versions of `browser-use` accept a CDP URL directly in their own `BrowserConfig`,
skipping manual Playwright wiring entirely:

```python
from browser_use import Agent, Browser, BrowserConfig

browser = Browser(config=BrowserConfig(cdp_url="http://localhost:9222"))
agent = Agent(task=payload.task, llm=llm, browser=browser)
result = await agent.run()
```

Prefer this form if available — it's less code and less likely to break on upgrades.

---

## 3. The Chrome extension

### 3.1 `manifest.json`

```json
{
  "manifest_version": 3,
  "name": "Browser-Use Agent Bridge",
  "version": "1.0.0",
  "description": "Send tasks to a local browser-use agent that controls this Chrome profile.",
  "permissions": ["storage"],
  "host_permissions": ["http://localhost:8000/*"],
  "action": {
    "default_popup": "popup.html",
    "default_title": "Browser-Use Agent"
  },
  "background": {
    "service_worker": "background.js"
  },
  "icons": {
    "16": "icon16.png",
    "48": "icon48.png",
    "128": "icon128.png"
  }
}
```

`host_permissions` for `http://localhost:8000/*` is what lets the extension call your
FastAPI server without CORS/permission prompts.

### 3.2 `popup.html`

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: system-ui, sans-serif; width: 320px; padding: 12px; }
    textarea { width: 100%; height: 80px; box-sizing: border-box; }
    button { margin-top: 8px; width: 100%; padding: 8px; cursor: pointer; }
    #status { margin-top: 8px; font-size: 12px; color: #555; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h3>Browser-Use Agent</h3>
  <textarea id="task" placeholder="e.g. Go to my Gmail and summarize unread emails from today"></textarea>
  <button id="runBtn">Run task</button>
  <div id="status"></div>
  <script src="popup.js"></script>
</body>
</html>
```

### 3.3 `popup.js`

```javascript
const SERVER_URL = "http://localhost:8000";

const taskEl = document.getElementById("task");
const statusEl = document.getElementById("status");
const runBtn = document.getElementById("runBtn");

runBtn.addEventListener("click", async () => {
  const task = taskEl.value.trim();
  if (!task) {
    statusEl.textContent = "Enter a task first.";
    return;
  }

  runBtn.disabled = true;
  statusEl.textContent = "Running agent... this can take a while.";

  try {
    const res = await fetch(`${SERVER_URL}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, max_steps: 25 }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Server error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    statusEl.textContent = `Done in ${data.steps_taken} steps.\n\n${data.result}`;
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}\n\nIs the FastAPI server running on ${SERVER_URL}?`;
  } finally {
    runBtn.disabled = false;
  }
});
```

### 3.4 `background.js`

Not strictly required for the minimal flow above (popup talks directly to the server),
but useful if you want to trigger tasks from a context menu, keyboard shortcut, or
persist state across popup closes:

```javascript
// background.js
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "run-agent-on-page",
    title: "Run agent task on this page",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "run-agent-on-page") return;

  const task = `On the current page (${tab.url}), do the following: ...`; // customize
  const res = await fetch("http://localhost:8000/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task }),
  });
  const data = await res.json();
  chrome.notifications?.create({
    type: "basic",
    iconUrl: "icon128.png",
    title: "Agent finished",
    message: data.result.slice(0, 200),
  });
});
```

Add `"contextMenus"` and `"notifications"` to `manifest.json` permissions if you use
this file.

### 3.5 Load the extension

1. Go to `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked" → select the folder containing `manifest.json`
4. Pin the extension icon for easy access

> **Note:** this extension runs in a *separate* Chrome process/profile context from
> the one the agent is controlling (or the same one, if you load the unpacked extension
> into the CDP-launched Chrome itself). Either works — the extension only needs network
> access to `localhost:8000`; it doesn't need to be loaded into the automated profile.

---

## 4. Running the whole stack end-to-end

```bash
# Terminal 1: launch Chrome with your profile exposed over CDP
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="/Users/you/Library/Application Support/Google/Chrome/Default" \
  --no-first-run --no-default-browser-check

# Terminal 2: start the FastAPI bridge
source venv/bin/activate
export ANTHROPIC_API_KEY=sk-ant-...
uvicorn server:app --port 8000 --reload
```

Then load the extension (Section 3.5) in any Chrome window, open the popup, type a
task, and click "Run task." The agent will drive the CDP-attached Chrome window using
your logged-in sessions.

---

## 5. Alternative / complementary approaches (for context)

**Approach 1 alone (FastAPI, no CDP attach):** `Agent` launches its *own* fresh Chromium
instance via Playwright, with no profile. Fine for anonymous/logged-out tasks; useless
for anything requiring your accounts.

**Approach 2 (Playwright launches Chrome with `--user-data-dir` directly):**

```python
context = await p.chromium.launch_persistent_context(
    user_data_dir="/Users/you/Library/Application Support/Google/Chrome/Default",
    headless=False,
)
```

This gives Playwright ownership of the browser lifecycle and profile in one call —
no separate `--remote-debugging-port` step needed. Simpler than Approach 3, but you
lose the ability to have a *human-visible, human-usable* Chrome window that's
simultaneously CDP-controllable from an already-running process; it's better suited to
scripts that fully own the browser process from start to finish rather than "attach to
what's already open."

**Approach 3 alone (raw CDP attach, no FastAPI/extension):** Useful for quick scripts
or debugging — just the `connect_over_cdp` snippet with no server or UI wrapper.

The guide above is Approach 1 + Approach 3 combined, which is the right choice when you
want a UI (the extension) driving an agent that acts through your real, already
logged-in browser session.

---

## 6. Common pitfalls

- **"Target closed" / connection refused on port 9222:** Chrome wasn't actually
  launched with the debug flag, or another process already holds the profile lock.
  Fully quit Chrome (check Activity Monitor / Task Manager for lingering `chrome`
  processes) before relaunching with the flag.
- **CORS errors in the extension console:** make sure `host_permissions` in
  `manifest.json` includes `http://localhost:8000/*`, and that the FastAPI app has
  `CORSMiddleware` enabled.
- **Agent can't see your logged-in sessions:** confirm you pointed `--user-data-dir`
  at the *same* profile directory your everyday Chrome uses (check `chrome://version`),
  not a fresh/default one.
- **browser-use version drift:** the exact constructor signatures for injecting an
  external CDP connection change between releases — always check
  `pip show browser-use` and the changelog/docs for your installed version before
  copy-pasting the `Agent(...)` call verbatim.
- **Security:** anything with `--remote-debugging-port` open gives *any* local process
  full control of that Chrome instance (and thus your logged-in accounts). Don't expose
  port 9222 beyond localhost, and be thoughtful about what tasks you let an LLM-driven
  agent run against your real accounts.
