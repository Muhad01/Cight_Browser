"""
Cight Browser-Use Agent Bridge Server — Extension-Controlled Mode

Architecture (no Chrome restart required):
  Extension popup sends task
      │ POST /agent/start
      ▼
  Server starts an agent session, returns session_id
      │ SSE /agent/{id}/stream  ←  popup listens for events
      │ POST /agent/{id}/state  ←  popup sends page state each step
      ▼
  Server calls LLM → decides next action → pushes to SSE stream
      │ Extension executes action via chrome.tabs / chrome.scripting
      │ Sends result back → POST /agent/{id}/action_result
      ▼
  Repeat until done
"""

import asyncio
import json
import logging
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from browser_use.llm import ChatAnthropic, ChatGoogle, ChatGroq

load_dotenv(Path(__file__).parent / ".env", override=True)

logger = logging.getLogger(__name__)

# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(title="Cight Agent Bridge", version="2.0.0")
app.add_middleware(
	CORSMiddleware,
	allow_origins=["*"],
	allow_methods=["*"],
	allow_headers=["*"],
)


# ── LLM ───────────────────────────────────────────────────────────────────────

def _build_llm(model: str):
	if model.startswith("gemini"):
		key = os.getenv("GOOGLE_API_KEY")
		if not key:
			raise HTTPException(503, "GOOGLE_API_KEY not set in agent_bridge/.env")
		return ChatGoogle(model=model, api_key=key)
	if model.startswith(("llama", "mixtral", "moonshard", "deepseek", "qwen", "compound")):
		key = os.getenv("GROQ_API_KEY")
		if not key:
			raise HTTPException(503, "GROQ_API_KEY not set in agent_bridge/.env")
		return ChatGroq(model=model, api_key=key)
	if model.startswith("claude"):
		key = os.getenv("ANTHROPIC_API_KEY")
		if not key:
			raise HTTPException(503, "ANTHROPIC_API_KEY not set in agent_bridge/.env")
		return ChatAnthropic(model=model, api_key=key)
	# fallback: try Groq (it hosts many open models)
	key = os.getenv("GROQ_API_KEY")
	if key:
		return ChatGroq(model=model, api_key=key)
	raise HTTPException(503, f"No API key configured for model '{model}'")


SYSTEM_PROMPT = """You are a browser automation agent. Given a task and the current state of a browser tab, decide the SINGLE best next action.

CRITICAL: Your ENTIRE response must be a single raw JSON object. No markdown. No backticks. No explanation. No text before or after. Start your response with { and end with }.

Available actions:
  {"type": "navigate",  "url": "https://..."}
  {"type": "click",     "selector": "CSS selector",  "description": "what you're clicking"}
  {"type": "type",      "selector": "CSS selector",  "text": "text to type"}
  {"type": "clear_and_type", "selector": "CSS selector", "text": "text to type"}
  {"type": "key",       "key": "Enter|Tab|Escape|ArrowDown|ArrowUp"}
  {"type": "scroll",    "direction": "down"|"up",    "pixels": 400}
  {"type": "wait",      "seconds": 1}
  {"type": "done",      "result": "Summary of what was accomplished"}
  {"type": "fail",      "reason": "Why the task cannot be completed"}

Rules:
- Prefer clicking visible interactive elements by their exact CSS selector
- If a selector is hard to determine from the content, use descriptive text and mention it in description
- Navigate directly to URLs when you know them
- Use "done" when the task is complete; include the final answer in "result"
- Use "fail" only if the task is genuinely impossible
"""


async def _ask_llm(llm, task: str, step: int, max_steps: int, page_state: dict, history: list[dict], _retry: int = 0) -> dict:
	"""Call the LLM with page state and get the next action as a dict."""
	history_text = ""
	if history:
		lines = []
		for h in history[-5:]:  # last 5 steps only
			lines.append(f"  Step {h['step']}: {h['action_type']} — {h.get('description','')}")
		history_text = "\nRecent steps:\n" + "\n".join(lines)

	user_msg = f"""Task: {task}
Step: {step + 1} of {max_steps}{history_text}

Current page:
  URL:   {page_state.get('url', 'unknown')}
  Title: {page_state.get('title', 'unknown')}

Page content (simplified):
{page_state.get('content', '(no content)')}

What is the next single action?"""

	# Build messages in the format the LLM expects
	from browser_use.llm.messages import SystemMessage, UserMessage
	messages = [SystemMessage(content=SYSTEM_PROMPT), UserMessage(content=user_msg)]

	response = await llm.ainvoke(messages)
	text = response.content if hasattr(response, "content") else str(response)

	# Strip markdown fences if present
	text = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.MULTILINE)
	text = re.sub(r"\s*```$", "", text.strip(), flags=re.MULTILINE)
	text = text.strip()

	# Attempt 1: direct parse
	try:
		return json.loads(text)
	except json.JSONDecodeError:
		pass

	# Attempt 2: extract first {...} block
	m = re.search(r"\{.*?\}", text, re.DOTALL)
	if m:
		try:
			return json.loads(m.group())
		except json.JSONDecodeError:
			pass

	# Attempt 3: find the largest {...} block
	m = re.search(r"\{.*\}", text, re.DOTALL)
	if m:
		try:
			return json.loads(m.group())
		except json.JSONDecodeError:
			pass

	# Attempt 4: heuristic — if text mentions a URL, treat as navigate
	url_m = re.search(r'https?://[^\s"\']+', text)
	if url_m:
		return {"type": "navigate", "url": url_m.group()}

	raise ValueError(f"LLM did not return valid JSON: {text[:300]}")


async def _ask_llm_with_retry(llm, task, step, max_steps, page_state, history, max_retries=3):
	"""Retry on 503 / rate-limit errors with exponential back-off."""
	import asyncio as _asyncio
	for attempt in range(max_retries):
		try:
			return await _ask_llm(llm, task, step, max_steps, page_state, history)
		except Exception as exc:
			msg = str(exc)
			is_retryable = "503" in msg or "UNAVAILABLE" in msg or "rate" in msg.lower() or "quota" in msg.lower()
			if is_retryable and attempt < max_retries - 1:
				wait = 20 * (attempt + 1)  # 20s, 40s, 60s — matches Google's retry guidance
				logger.warning("LLM 503/rate-limit (attempt %d/%d) — retrying in %ds", attempt + 1, max_retries, wait)
				await _asyncio.sleep(wait)
				continue
			raise


# ── Agent session ──────────────────────────────────────────────────────────────

class AgentSession:
	def __init__(self, session_id: str, task: str, model: str, max_steps: int):
		self.session_id  = session_id
		self.task        = task
		self.model       = model
		self.max_steps   = max_steps
		self.step        = 0
		self.status      = "running"
		self.started_at  = datetime.now().isoformat()

		# Synchronization between agent loop and HTTP handlers
		self._state_ready  = asyncio.Event()
		self._result_ready = asyncio.Event()
		self.page_state: dict | None  = None
		self.action_result: dict | None = None

		# SSE event queue
		self._events: asyncio.Queue[dict | None] = asyncio.Queue()
		self.history: list[dict] = []

	def push(self, event: dict):
		self._events.put_nowait(event)

	async def stream(self) -> AsyncGenerator[str, None]:
		while True:
			event = await self._events.get()
			if event is None:  # sentinel: session done
				break
			yield f"data: {json.dumps(event)}\n\n"
			if event.get("type") in ("done", "error"):
				break

	def close(self):
		self._events.put_nowait(None)


_sessions: dict[str, AgentSession] = {}


# ── Agent loop ─────────────────────────────────────────────────────────────────

async def _agent_loop(session: AgentSession):
	try:
		llm = _build_llm(session.model)
	except HTTPException as e:
		session.push({"type": "error", "message": e.detail})
		session.status = "error"
		session.close()
		return

	session.push({"type": "start", "task": session.task, "session_id": session.session_id})

	for step in range(session.max_steps):
		session.step = step

		# 1. Ask the extension for the current page state
		session._state_ready.clear()
		session.push({"type": "request_state", "step": step})

		try:
			await asyncio.wait_for(session._state_ready.wait(), timeout=30)
		except asyncio.TimeoutError:
			session.push({"type": "error", "message": "Timed out waiting for page state from extension."})
			session.status = "error"
			session.close()
			return

		page_state = session.page_state

		# 2. Ask LLM for next action
		session.push({"type": "thinking", "step": step, "url": page_state.get("url", "")})
		try:
			action = await _ask_llm_with_retry(llm, session.task, step, session.max_steps, page_state, session.history)
		except Exception as exc:
			session.push({"type": "error", "message": f"LLM error: {exc}"})
			session.status = "error"
			session.close()
			return

		# 3. Publish action for the extension to execute
		action_event = {"type": "action", "step": step, "action": action}
		session.push(action_event)
		session.history.append({
			"step": step,
			"action_type": action.get("type", "?"),
			"description": action.get("description", action.get("url", action.get("text", action.get("result", "")))),
		})

		# 4. Terminal actions
		if action.get("type") == "done":
			session.push({"type": "done", "result": action.get("result", "Task completed."), "steps": step + 1})
			session.status = "done"
			session.close()
			return

		if action.get("type") == "fail":
			session.push({"type": "error", "message": action.get("reason", "Task failed.")})
			session.status = "error"
			session.close()
			return

		# 5. Wait for extension to report action result
		session._result_ready.clear()
		try:
			await asyncio.wait_for(session._result_ready.wait(), timeout=20)
		except asyncio.TimeoutError:
			session.push({"type": "error", "message": "Timed out waiting for action result from extension."})
			session.status = "error"
			session.close()
			return

		result = session.action_result or {}
		if result.get("error"):
			session.push({"type": "step_error", "step": step, "message": result["error"]})
			# Don't abort — let the LLM recover on next step

	# Exceeded max steps
	session.push({"type": "error", "message": f"Reached max steps ({session.max_steps}) without completing."})
	session.status = "error"
	session.close()


# ── Pydantic models ────────────────────────────────────────────────────────────

class StartRequest(BaseModel):
	task: str
	model: str = Field("gemini-2.5-flash")
	max_steps: int = Field(25, ge=1, le=100)


class PageStatePayload(BaseModel):
	url: str = ""
	title: str = ""
	content: str = ""


class ActionResultPayload(BaseModel):
	success: bool = True
	error: str | None = None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@app.get("/ping")
async def ping():
	return "pong"


@app.get("/health")
async def health():
	return {"status": "ok", "active_sessions": sum(1 for s in _sessions.values() if s.status == "running")}


@app.post("/agent/start")
async def agent_start(req: StartRequest):
	session_id = str(uuid.uuid4())[:8]
	session = AgentSession(session_id, req.task, req.model, req.max_steps)
	_sessions[session_id] = session
	asyncio.create_task(_agent_loop(session))
	return {"session_id": session_id}


@app.get("/agent/{session_id}/stream")
async def agent_stream(session_id: str):
	session = _sessions.get(session_id)
	if not session:
		raise HTTPException(404, f"Session {session_id!r} not found")
	return StreamingResponse(
		session.stream(),
		media_type="text/event-stream",
		headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
	)


@app.post("/agent/{session_id}/state")
async def agent_receive_state(session_id: str, payload: PageStatePayload):
	session = _sessions.get(session_id)
	if not session:
		raise HTTPException(404, f"Session {session_id!r} not found")
	session.page_state = payload.model_dump()
	session._state_ready.set()
	return {"ok": True}


@app.post("/agent/{session_id}/action_result")
async def agent_receive_result(session_id: str, payload: ActionResultPayload):
	session = _sessions.get(session_id)
	if not session:
		raise HTTPException(404, f"Session {session_id!r} not found")
	session.action_result = payload.model_dump()
	session._result_ready.set()
	return {"ok": True}


if __name__ == "__main__":
	import uvicorn
	uvicorn.run("server:app", host="127.0.0.1", port=8000)
