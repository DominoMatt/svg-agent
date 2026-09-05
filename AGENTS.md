# AGENTS.md — Onboarding the Three Servers

This file tells future agents (and humans) how to bring up and verify the
**three servers** that power this repo, and how to avoid the known pitfalls.

> The three servers are: **Ollama** (`:11434`, model inference), **Harness**
> (`:5174`, queue + scheduler + API), and **UI** (`:5173`, static + reverse
> proxy). The browser only ever talks to the UI server; it proxies everything
> else.

---

## 1. Architecture at a glance

```
Browser (public/) ──► UI server (:5173) ──► /api/harness/* ──► Harness (:5174)
                        │  static files          │
                        └─► /api/ollama/* ───────┴─► Ollama (:11434)
                        └─► /api/studio/* ──────────► Studio (:3000) [future]
```

Harness flow (no central orchestrator):

```
POST /start ─► enqueue svg-planner ─► actors/runner.mjs ─► Ollama chat
   │                                                          │
   │   appendEvent() to data/log.jsonl                        │
   │   putBlob() output to data/blobs/ (SHA256, content-addressed)
   │   broadcast() WS events: enqueued / started / completed / failed
   └─► checkRoutingRules() reads routes.yaml, enqueues next actor
```

---

## 2. Starting the three servers

All commands run from the repo root (`/workspaces/svg-agent`).

### Server 1 — Ollama (`:11434`) — run once, keep running

```bash
ollama serve &
```

Pull the target model (run once):

```bash
ollama pull openbmb/minicpm5
```

Verify:

```bash
curl -s http://127.0.0.1:11434/api/tags
```

The model tag used by the harness is `openbmb/minicpm5:latest` (defined in
`registry/models.yaml`).

### Server 2 — Harness (`:5174`)

```bash
cd /workspaces/svg-agent && node server/harness.mjs
```

Expected startup output:

```
  Harness API
  ────────────
  Port:     5174
  Actors:   planner, refiner, researcher, svg-coder, svg-planner, svg-refiner, svg-researcher, svg-validator
  Models:   minicpm5, qwen2.5-coder-1.5b, smollm2-1.7b, default
  WS:       ws://localhost:5174/api/harness/ws
```

Verify:

```bash
curl -s http://localhost:5174/api/harness/health
# → {"status":"ok","uptimeMs":...,"queueLength":0,"processing":false}
```

### Server 3 — UI (`:5173`)

```bash
cd /workspaces/svg-agent && node server/index.mjs
```

Expected startup output:

```
  llm-agent playground
  ───────────────────
  UI:      http://localhost:5173
  Ollama:  http://127.0.0.1:11434
  Studio:  http://127.0.0.1:3000 (future)
```

Verify:

```bash
curl -s http://localhost:5173/healthz
```

---

## 3. End-to-end smoke test

```bash
curl -X POST http://localhost:5174/api/harness/start \
  -H "Content-Type: application/json" \
  -d '{"goal": "Create a simple red circle SVG"}'
```

Then open `http://localhost:5173` → **Harness** tab. You should see:

1. Agent pills appear as steps start (thinking spinner)
2. Pills flip to ✓ when complete
3. Output renders under each pill (JSON for `svg-planner`, SVG preview + code
   for `svg-coder`)

To watch live events without the browser, connect to the WS:

```bash
node -e '
const ws = new WebSocket("ws://localhost:5174/api/harness/ws");
ws.onmessage = (e) => console.log(e.data);
'
```

---

## 4. Harness API quick reference

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/harness/start` | Start a run (`{goal}`) — enqueues `svg-planner` |
| POST | `/api/harness/enqueue` | Manually enqueue an envelope |
| GET | `/api/harness/trace/:runId` | DAG trace of steps (drives the UI) |
| GET | `/api/harness/log/:runId` | Raw events for a run |
| GET | `/api/harness/actors` | List actor manifests |
| GET | `/api/harness/models` | List model registry |
| POST | `/api/harness/replay/:runId/:step` | Re-run a step onward |
| GET | `/api/harness/metrics` | Uptime, step counts, avg durations |
| GET | `/api/harness/health` | Liveness |
| GET | `/api/harness/blob/:cid` | Fetch blob content |
| GET | `/api/harness/runs` | List all runs |
| GET | `/api/harness/dead-letter` | List failed envelopes |
| POST | `/api/harness/dead-letter/retry` | Re-queue a dead letter |
| GET | `/api/harness/export/:runId` | Export run + blobs as JSON |
| POST | `/api/harness/import` | Import an exported run |

---

## 5. Where the data lives

| Path | Contents |
|---|---|
| `data/log.jsonl` | Append-only event log (one JSON event per line) |
| `data/queue.jsonl` | Persisted pending/running queue (survives restart) |
| `data/dead-letter.jsonl` | Failed envelopes after retries exhausted |
| `data/blobs/<shard>/<sha256>` | Content-addressed output/context blobs |

---

## 6. Known pitfalls (learned the hard way)

1. **`server/harness.mjs` is an ES module** — NEVER use `require()` in it
   (crashes the server on WS connect). Use top-level `import` only.
2. **WS frame length encoding** — `socket.send()` must encode extended payload
   lengths (>125 bytes) with 16/64-bit headers, or the browser gets malformed
   frames. The `completed` broadcast is trimmed to
   `{ outputCid, eventTypes, tokensEstimated }` to keep frames small.
3. **Always attach `socket.on("error")`** to WS sockets — an unhandled EPIPE on
   abrupt client disconnect (tab close, network drop) crashes the whole server.
4. **`getRunTrace()` must include `payloadRef` + `metadata`** per step, or the
   frontend `renderChat()` won't render output
   (`if (step.status === "ok" && step.payloadRef)` is always false).
5. **Frontend pills/messages rely on `data-step`** — `renderChat()` and
   `renderCompletedStep()` use it to find/update elements in place.
6. **`pollTrace()` re-renders trace + chat every ~2s.** NEVER wipe `innerHTML`
   in these renderers — it collapses trace dropdowns and makes chat messages
   flicker. `renderChat()` is incremental; `renderTrace()` preserves the
   `.expanded` set + `scrollTop`.
7. **`server/index.mjs` serves static files with `Cache-Control: no-cache`** so
   JS/CSS changes are picked up. If the UI looks stale, hard-refresh
   (Ctrl+Shift+R) — the browser may still hold the old `app.js`.
8. **Test WS with a small node client** (see the snippet in §3) and re-check
   `GET /api/harness/health` after an abrupt disconnect to confirm the server
   survived.

---

## 7. Where to look when something breaks

| Symptom | Look here |
|---|---|
| Run fails / step errors | `data/dead-letter.jsonl`, `data/log.jsonl` |
| Output not rendering under pills | `getRunTrace()` payloadRef/metadata (pitfall 4) |
| UI flicker / dropdowns closing | `renderChat()`/`renderTrace()` wiping (pitfall 6) |
| Server crashed on WS connect | `require()` in an `.mjs` file (pitfall 1) |
| Malformed WS frames | frame length encoding (pitfall 2) |
| Stale UI after code change | hard refresh / no-cache header (pitfall 7) |

The known-pitfalls list in §6 is the accumulated record of past issues and
their fixes — read it before debugging a recurring symptom.