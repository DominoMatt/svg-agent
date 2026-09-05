# Harness Output Display Issue - Session Notes

## Problem Statement
The harness runs agents (svg-planner, svg-coder, etc.) and shows "agent pills" in the chat view, but the actual output from each agent (JSON for planner, SVG for coder) was not displaying under the corresponding pill when the step completed.

## Root Cause
The WebSocket `completed` message from the harness server includes the `result` object with `outputCid`, but the frontend only called `pollTrace()` instead of immediately rendering the completed step's output. The trace polling would eventually show it, but not in real-time.

## Solution Implemented
Modified `/workspaces/svg-agent/public/js/app.js` to handle the `completed` WebSocket message by immediately rendering the output:

1. **Added `renderCompletedStep(msg)` function** (lines ~975-1030) that:
   - Creates/updates the agent pill with ✓ status
   - Creates a chat message container
   - Fetches blob content via `fetchBlobForChat(cid, container)`
   - Renders JSON as formatted code, SVG as preview + code

2. **Updated `handleWebSocketMessage()`** to call `renderCompletedStep(msg)` on `completed` type messages

3. **Fixed `fetchBlobForChat()` call** - removed extra `actor` parameter that wasn't in the function signature

## Code Changes

### `/workspaces/svg-agent/public/js/app.js`
- Added `renderCompletedStep()` function
- Modified `handleWebSocketMessage()` switch case for `"completed"`
- Fixed `fetchBlobForChat()` call signature

## Server Startup Commands

### 1. Start Ollama (run once, keeps running)
```bash
ollama serve &
```
Then pull the model (run once):
```bash
ollama pull openbmb/minicpm5
```

### 2. Start Harness Server (port 5174)
```bash
cd /workspaces/svg-agent && node server/harness.mjs
```
Output:
```
  Harness API
  ────────────
  Port:     5174
  Actors:   planner, refiner, researcher, svg-coder, svg-planner, svg-refiner, svg-researcher, svg-validator
  Models:   minicpm5, qwen2.5-coder-1.5b, smollm2-1.7b, default
  WS:       ws://localhost:5174/api/harness/ws
```

### 3. Start Main UI Server (port 5173)
```bash
cd /workspaces/svg-agent && node server/index.mjs
```
Output:
```
  llm-agent playground
  ───────────────────
  UI:      http://localhost:5173
  Ollama:  http://127.0.0.1:11434
  Studio:  http://127.0.0.1:3000 (future)
```

## Test a Run
```bash
curl -X POST http://localhost:5174/api/harness/start \
  -H "Content-Type: application/json" \
  -d '{"goal": "Create a simple red circle SVG"}'
```

Then open http://localhost:5173 → click **Harness** tab → you should see:
1. Agent pills appear as steps start (thinking spinner)
2. Pills update to ✓ when complete
3. **Output appears under each pill**: JSON for svg-planner, SVG preview + code for svg-coder

## Current Status (as of 2026-09-05)
- ✅ Ollama running with minicpm5 model
- ✅ Harness server running on :5174
- ✅ UI server running on :5173
- ✅ WebSocket connection working
- ✅ Agent pills display and update
- ⚠️ **Need to verify**: Output rendering under pills in real-time (tested via API, trace shows events with payloadRefs)

## Key Files
- `server/harness.mjs` - Harness API + WebSocket broadcaster
- `server/index.mjs` - Main UI server (serves public/, proxies to Ollama)
- `public/js/app.js` - Frontend logic (WebSocket handling, rendering)
- `actors/runner.mjs` - Actor execution, emits events with outputCid
- `server/log.mjs` - Event log (JSONL)

## Next Steps to Investigate
1. Verify the `renderCompletedStep()` actually triggers in browser (check console for "[Harness] WebSocket connected")
2. Check if `fetchBlobForChat()` correctly renders SVG vs JSON
3. Ensure the chat container (`#harness-chat`) is visible when on Harness tab and is also located in the correct spot spatially.
4. Consider adding "started" handler to show thinking pill immediately (currently only shows on trace poll)