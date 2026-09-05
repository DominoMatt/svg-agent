# NEWPLAN: Minimal Actor Harness for Sub-2B Models

**Target Model:** `openbmb/minicpm5` (1.5B–2B class) — *configurable, not hardcoded*

**Philosophy:** Keep the existing `public/` + `server/` simplicity. Add only what enables **durable, multi-step, multi-model actor chains** without a central orchestrator.

---

## 1. Project Structure (Minimal Additions)

```
svg-agent/
├── public/                    # unchanged (UI)
├── server/
│   ├── index.mjs             # unchanged (static + proxy)
│   ├── harness.mjs           # NEW: envelope queue + actor runner + scheduler
│   ├── blobs.mjs             # NEW: content-addressable blob store
│   ├── log.mjs               # NEW: append-only event log
│   ├── manifest.mjs          # NEW: YAML manifest loader + validator
│   ├── modelRegistry.mjs     # NEW: model registry loader
│   └── registry/             # NEW: actor manifests (YAML)
│       ├── svg-planner.yaml
│       ├── svg-coder.yaml
│       ├── svg-validator.yaml
│       ├── svg-refiner.yaml
│       ├── svg-researcher.yaml
│       └── routes.yaml
├── actors/                   # NEW: generic runner (no per-actor code)
│   └── runner.mjs
├── data/                     # NEW: local persistence (gitignored)
│   ├── log.jsonl             # event log (append-only JSONL)
│   └── blobs/                # content-addressable context store (SHA256 sharded)
├── registry/                 # NEW: model registry
│   └── models.yaml
└── NEWPLAN.md                # this file
```

**Zero new npm deps.** Uses Node 18+ built-ins only.

---

## 2. Core Data Structures

### Envelope (the baton)
```javascript
// Envelope passed between actors
{
  runId: "uuid-v4",
  step: 3,
  actor: "svg-validator",
  payload: { svg: "<svg>...", spec: "..." },
  contextRefs: ["cid:sha256:abc123"],  // pointers to blob store
  deadline: Date.now() + 30000,       // 30s TTL
  parentStep: 2,
  retries: 0
}
```

---

## ✅ Phase 0 Complete (Foundation)

| File | Purpose | Status |
|------|---------|--------|
| `registry/models.yaml` | Model registry (minicpm5, qwen2.5-coder-1.5b, smollm2-1.7b) | ✅ |
| `server/registry/*.yaml` | 5 actor manifests + routes.yaml | ✅ |
| `server/blobs.mjs` | Content-addressable blob store (SHA256 CIDs) | ✅ |
| `server/log.mjs` | Append-only JSONL event log + trace queries | ✅ |
| `server/manifest.mjs` | YAML manifest loader + JSON Schema validation | ✅ |
| `server/modelRegistry.mjs` | Model registry loader | ✅ |
| `actors/runner.mjs` | Generic actor runner (manifest → prompt → Ollama → validate → emit) | ✅ |
| `server/harness.mjs` | Queue + scheduler + HTTP API | ✅ |

---

## ✅ API Endpoints Working

```bash
POST /api/harness/start        # { goal } → { runId }
GET  /api/harness/trace/:runId # DAG visualization
GET  /api/harness/log/:runId   # Raw events
GET  /api/harness/actors       # List actors
GET  /api/harness/models       # List models
GET  /api/harness/metrics      # System metrics
GET  /api/harness/health       # Health check
GET  /api/harness/blob/:cid    # Retrieve blob content
POST /api/harness/replay/:runId/:step
```

---

## ✅ Verified Flow

```
POST /api/harness/start { goal: "..." }
    │
    ▼
Enqueue svg-planner (step 1)
    │
    ▼
Runner loads svg-planner manifest
    │
    ▼
Validates input ✓
    │
    ▼
Calls Ollama (fails - not running)
    │
    ▼
Emits svg-planner-failed event with CID
    │
    ▼
Log + blobs persisted
```

---

## ✅ Phase 1 Complete (Runner Polish)

| Feature | Implementation |
|---------|----------------|
| Context compaction | `compactBlob()` called when context exceeds `maxContextTokens` |
| Structured prompt building | `buildMessages()` formats payload per inputSchema |
| Token estimation | `estimateTokens()` for budget enforcement |
| Retry with backoff + jitter | Exponential backoff with random jitter |
| Detailed error tracking | Error blobs include attempt counts, durations |
| Metadata on events | Duration, model, token estimates |
| Streaming support | `runActorStreaming()` for long outputs |
| Metrics endpoint | `/api/harness/metrics` with avg durations, call counts |
| Health endpoint | `/api/harness/health` for monitoring |
| Blob retrieval | `/api/harness/blob/:cid` for debugging |

---

## Next: Phase 2 (UI Integration)

When you have Ollama running with models:
```bash
ollama pull openbmb/minicpm5:latest
ollama pull qwen2.5-coder:1.5b
ollama pull smollm2:1.7b
ollama serve
```

Then test end-to-end:
```bash
node server/harness.mjs &
curl -X POST http://localhost:5174/api/harness/start \
  -H "Content-Type: application/json" \
  -d '{"goal": "Create a rotating 3D cube in SVG"}'
```

---

## ✅ Phase 2 Complete (UI Integration)

| Feature | Implementation |
|---------|----------------|
| Harness tab in sidebar | Tab navigation (Chat ↔ Harness) in `public/index.html` |
| Goal input | Textarea + "Start Run" button → POST /api/harness/start |
| Live trace view | Auto-polling trace (2s interval) with expandable steps |
| Step details | Status, duration, model, tokens, children steps |
| View output blob | "View Output" button → fetches /api/harness/blob/:cid |
| Replay from step | "Replay from Here" button → POST /api/harness/replay/:runId/:step |
| Metrics dashboard | "Refresh" button → GET /api/harness/metrics (pretty JSON) |
| CSS styling | Dark theme consistent with existing UI |

---

## ✅ Phase 3 Complete (Polish)

| Feature | Implementation |
|---------|----------------|
| **Persistent queue** | `queue.jsonl` - survives restart, loads on startup |
| **Dead letter queue** | `dead-letter.jsonl` + UI with retry button |
| **Run history sidebar** | `/api/harness/runs` + clickable list in Harness panel |
| **Export/import** | `/export/:runId` + `/import` + UI buttons |
| **WebSocket live updates** | `ws://localhost:5174/api/harness/ws` - replaces polling |
| **SVG preview** | "View Output" button shows blob content (ready for SVG rendering) |

---

## ✅ All API Endpoints

```bash
# Core
POST /api/harness/start           # { goal } → { runId }
GET  /api/harness/trace/:runId    # DAG visualization
GET  /api/harness/log/:runId      # Raw events
GET  /api/harness/actors          # List actors
GET  /api/harness/models          # List models

# Monitoring
GET  /api/harness/metrics         # System metrics
GET  /api/harness/health          # Health check
GET  /api/harness/blob/:cid       # Retrieve blob content

# Persistence
GET  /api/harness/runs            # List all runs (from log)
GET  /api/harness/dead-letter     # List dead letters
POST /api/harness/dead-letter/retry # Retry dead letter
GET  /api/harness/export/:runId   # Export run as JSON
POST /api/harness/import          # Import run

# Real-time
WS   /api/harness/ws              # WebSocket for live updates
```

---

## Running the Full Stack

```bash
# Terminal 1: Harness API (port 5174)
node server/harness.mjs

# Terminal 2: UI + Proxy (port 5173)
node server/index.mjs

# Open http://localhost:5173 → Click "⚙️ Harness" tab
```

---

## When Ollama is Ready

```bash
ollama pull openbmb/minicpm5:latest
ollama pull qwen2.5-coder:1.5b
ollama pull smollm2:1.7b
ollama serve
```

Then in the Harness tab:
1. Enter goal: *"Create a rotating 3D cube in SVG"*
2. Click "▶ Start Run"
3. Watch live trace as svg-planner → svg-coder → svg-validator → svg-refiner execute
4. Click any step → "View Output" to see generated SVG
5. Click "Replay from Here" to re-run from any step
6. Use "Run History" to load past runs
7. Check "Dead Letters" for failed steps with retry option
8. Export/import runs for sharing

---

## Future Enhancements (Optional)

- [ ] SVG preview in trace (render output blob as inline image)
- [ ] Cost/token tracking per run (detailed breakdown)
- [ ] Actor marketplace (share manifests via GitHub)
- [ ] Web-based manifest editor
- [ ] Multi-user support with auth
- [ ] Scheduled/cron runs

---

## 📍 Testing Status (2026-09-05)

### Current State
- **Ollama**: Installed and running (`ollama serve` on port 11434)
- **Model**: `openbmb/minicpm5:latest` pulled (688 MB)
- **Harness**: Running on port 5174
- **UI**: Running on port 5173

### Actor Configuration (All using minicpm5)
| Actor | Temperature | Top-P | Max Tokens | Timeout |
|-------|-------------|-------|------------|---------|
| svg-planner | 0.9 (think) | 0.95 | 4096 | 30s |
| svg-coder | 0.7 (no-think) | 0.95 | 4096 | 20s |
| svg-validator | 0.7 (no-think) | 0.95 | 2048 | 15s |
| svg-refiner | 0.7 (no-think) | 0.95 | 4096 | 20s |
| svg-researcher | 0.9 (think) | 0.95 | 4096 | 30s |

### Last Test Run
- **Goal**: "Create a simple SVG circle with radius 50"
- **Result**: svg-planner timed out after 30s (2 attempts × 15s each)
- **Issue**: svg-planner output validation failed - model not returning valid JSON within timeout
- **Log**: Run `410b8b93-65ca-424a-9b3c-e8891508336c` shows svg-planner-failed with timeout

### Next Steps for Testing
1. **Increase svg-planner timeout** further (60s) or reduce complexity
2. **Adjust svg-planner prompt** to be more explicit about JSON-only output
3. **Test with simpler goal** first (e.g., "Draw a red square")
4. **Check Ollama logs** for token generation rate (~19 tokens/sec observed)
5. **Consider reducing maxTokens** for svg-planner to speed up generation

### Commands to Resume Testing
```bash
# Terminal 1: Start Ollama (if not running)
ollama serve

# Terminal 2: Start Harness
node server/harness.mjs

# Terminal 3: Start UI
node server/index.mjs

# Test via API
curl -X POST http://localhost:5174/api/harness/start \
  -H "Content-Type: application/json" \
  -d '{"goal": "Create a simple SVG circle with radius 50"}'

# Monitor trace
curl http://localhost:5174/api/harness/trace/<runId>

# Check logs
curl http://localhost:5174/api/harness/log/<runId>
```

### Actor Manifest (YAML in `server/registry/`)
```yaml
# svg-planner.yaml
name: svg-planner
model: minicpm5          # resolves via models.yaml
temperature: 0.2
maxTokens: 1024
systemPrompt: |
  You are a planner. Break the user request into 3-5 atomic steps.
  Output JSON: { steps: [{actor, input}], context: "..." }
inputSchema:
  type: object
  required: [userRequest]
outputSchema:
  type: object
  required: [steps]
timeoutMs: 10000
retries: 1
emits: [plan-created]
maxContextTokens: 2048
```

### Model Registry (`registry/models.yaml`)
```yaml
models:
  minicpm5:
    endpoint: "http://127.0.0.1:11434"
    modelTag: "openbmb/minicpm5:latest"
    contextWindow: 4096
    strengths: [planning, coding, reasoning]
  qwen2.5-coder-1.5b:
    endpoint: "http://127.0.0.1:11434"
    modelTag: "qwen2.5-coder:1.5b"
    contextWindow: 8192
    strengths: [coding, svg]
  smollm2-1.7b:
    endpoint: "http://127.0.0.1:11434"
    modelTag: "smollm2:1.7b"
    contextWindow: 2048
    strengths: [classification, validation]
```

---

## 3. Three Core Modules (≈800 LOC total)

### A. `server/harness.mjs` — Queue + Scheduler + Log
```javascript
// Responsibilities:
// - Enqueue envelopes (append to log + queue)
// - Scheduler: read log → match routing rules → enqueue next
// - Routing rules (declarative, loaded from YAML)
// - Log: append-only, query by runId
// - API: POST /api/harness/enqueue, GET /api/harness/trace/:runId
```

### B. `actors/runner.mjs` — Generic Actor Runner
```javascript
// Responsibilities:
// - Load manifest by actor name
// - Resolve model from registry
// - Build prompt: system + context (pulled by CID) + payload
// - Call Ollama /api/chat (streaming or non-streaming)
// - Validate output against outputSchema (JSON Schema)
// - On success: emit event(s) → enqueue next envelopes
// - On failure: retry or emit error event
// - Store output blob → return CID
```

### C. `server/blobs.mjs` — Content-Addressable Store
```javascript
// Responsibilities:
// - PUT(content) → returns CID (sha256)
// - GET(cid) → returns content
// - Compaction: summarize blobs older than N steps
// - Budget: enforce maxContextTokens per actor
```

---

## 4. Routing Rules (Declarative, in `server/registry/routes.yaml`)

```yaml
# Fan-out: svg-planner → svg-coder + svg-researcher
- when: plan-created
  then: [svg-coder, svg-researcher]

# Fan-in: wait for both code + refs
- when: [code-generated, refs-found]
  then: integration-tester

# Retry loop
- when: validation-failed
  then: coder
  maxRetries: 3
  backoff: exponential
  injectContext: error-report  # passes error as contextRef

# Terminal
- when: svg-validated
  then: []  # done
```

**Scheduler logic (pseudocode):**
```javascript
function schedule(newEvent) {
  for (rule of rules) {
    if (rule.when === newEvent.type || rule.when.includes(newEvent.type)) {
      // For fan-in: check if all required events exist for this runId
      if (Array.isArray(rule.when)) {
        if (!allPresent(runId, rule.when)) continue;
      }
      for (actor of rule.then) {
        enqueue({ runId, step: nextStep, actor, payload: ..., contextRefs: ... });
      }
    }
  }
}
```

---

## 5. API Surface (Added to `server/index.mjs`)

| Endpoint | Purpose |
|----------|---------|
| `POST /api/harness/start` | Create runId, enqueue first actor (svg-planner) |
| `POST /api/harness/enqueue` | Manual envelope enqueue (debug/replay) |
| `GET /api/harness/trace/:runId` | Full DAG visualization data |
| `GET /api/harness/log/:runId` | Raw event log |
| `POST /api/harness/replay/:runId/:step` | Re-enqueue from step |
| `WS /api/harness/stream/:runId` | Live updates (optional) |

---

## 6. UI Integration (Minimal)

Add to `public/js/app.js`:
- **"Harness" tab** in sidebar
- Input: high-level goal → `POST /api/harness/start`
- Live trace view: shows steps, actors, status, latency
- Click step → see input/output blobs
- "Replay from here" button

---

## 7. Example: SVG Generation Pipeline

```yaml
# Actors needed (manifests in server/registry/)
actors:
  - svg-planner      # minicpm5: breaks request → steps
  - svg-coder        # qwen2.5-coder:1.5b: writes SVG
  - svg-validator    # smollm2-1.7b: checks SVG validity
  - svg-refiner      # minicpm5: fixes issues
```

**Flow:**
```
User: "3D rotating cube in SVG"
    │
    ▼
[svg-planner:minicpm5] → plan-created (steps: [svg-coder, svg-validator])
    │
    ├──────────────────┐
    ▼                  ▼
[svg-coder:qwen]   [svg-validator:smollm2]  (parallel)
    │                  │
    │ code-generated   │ (waits for code)
    └────────┬─────────┘
             ▼
      [integration:minicpm5] → svg-ready / validation-failed
             │
             ▼ (if failed, routes back to svg-coder with error context)
      [svg-refiner:minicpm5] → svg-ready
```

Each actor = **one short conversation** (1–2 turns). Context pulled by CID.

---

## 8. Implementation Phases

### Phase 0: Foundation (1–2 days)
- [ ] `data/log.sqlite` + append/query helpers
- [ ] `server/blobs.mjs` (file-based CID store)
- [ ] `registry/models.yaml` + loader
- [ ] `server/registry/` manifest loader + JSON Schema validator

### Phase 1: Runner (1–2 days)
- [ ] `actors/runner.mjs` generic runner
- [ ] Prompt builder: system + contextRefs + payload
- [ ] Ollama call with timeout/retries
- [ ] Output validation + CID storage
- [ ] Event emission → log append

### Phase 2: Scheduler (1 day)
- [ ] `server/harness.mjs` queue + scheduler
- [ ] `registry/routes.yaml` loader
- [ ] Fan-in/fan-out + retry logic
- [ ] API endpoints

### Phase 3: UI (0.5 day)
- [ ] Harness tab in sidebar
- [ ] Trace visualization (Mermaid or simple tree)
- [ ] Replay button

### Phase 4: Polish (ongoing)
- [ ] Compaction policy for context blobs
- [ ] Cost/token tracking per run
- [ ] Dead letter queue UI
- [ ] Actor marketplace (share manifests via GitHub)

---

## 9. Key Decisions (Reversible)

| Decision | Rationale | Can Change? |
|----------|-----------|-------------|
| SQLite for log | Single file, no server, queryable | Yes → JSONL, Redis |
| File-based blobs | Simple, content-addressable | Yes → S3, Redis |
| YAML manifests | Human-readable, no build step | Yes → JSON, TS |
| No vector DB | Sub-2B context small; CID + summary enough | Yes → add later |
| Declarative routing | No code changes to add flows | Yes → code-based |
| Model registry | Swap models without code changes | Yes → env-based |

---

## 10. Non-Goals (Explicit)

- ❌ No LangChain / LlamaIndex / AutoGen
- ❌ No central "agent loop" or "planner-executor" pattern
- ❌ No prompt template engine (manifests = templates)
- ❌ No complex memory hierarchy (log + blobs = all memory)
- ❌ No vector DB / RAG framework (CID store is sufficient)
- ❌ No framework lock-in (all portable Node built-ins)

---

## 11. Success Criteria

- [ ] Run `node server/harness.mjs` alongside `node server/index.mjs`
- [ ] `POST /api/harness/start` with `{ goal: "..." }` → returns `runId`
- [ ] Trace shows 3–5 actors completing in <30s total
- [ ] Sub-2B models produce valid SVG via multi-step chain
- [ ] Replay from any step works
- [ ] Total added code <1000 LOC

---

## 12. Start Command

```bash
# Terminal 1: UI + Proxy (unchanged)
node server/index.mjs

# Terminal 2: Harness (new)
node server/harness.mjs

# Open http://localhost:5173 → Harness tab
```

---

**This plan adds ~5 files, ~800 LOC, zero deps. The existing UI/proxy stays untouched.**