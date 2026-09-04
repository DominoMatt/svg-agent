# llm-agent

A local LLM playground — chat with models via Ollama through a clean web UI. Zero
build step, zero npm dependencies, just `node` and a browser.

```
┌────────────────────────────────────────────────────────┐
│                    Browser UI                           │
│  ┌──────────┐  ┌──────────────────────────────────┐   │
│  │ Sidebar  │  │ Stage                             │   │
│  │ Presets  │  │ Streaming chat, temp/tokens ctrl  │   │
│  │ Adapter  │  │                                    │   │
│  │ Model    │  │                                    │   │
│  └──────────┘  └──────────────────────────────────┘   │
└──────────────────────┬─────────────────────────────────┘
                       │ /api/*
                       ▼
            ┌────────────────────┐
            │  Node.js proxy    │  server/index.mjs
            │  (static + proxy) │  :5173
            └────────┬──────────┘
                     │
                     ▼
            ┌────────────────────┐
            │  Ollama            │  :11434
            │  (local models)   │
            └────────────────────┘
```

**Zero dependencies** — the server uses only Node ≥ 18 built-ins (`http`, `fs`,
`fetch`). The frontend is plain HTML/CSS/JS with no bundler.

## Quick Start

### 1. Install Ollama

Follow [ollama.ai](https://ollama.ai) for your platform, then pull a model:

```bash
ollama pull qwen2.5-coder:3b   # or any model you prefer
```

### 2. Start the playground

```bash
node server/index.mjs
```

Open **http://localhost:5173** in your browser.

### 3. Chat

Pick a preset from the sidebar, type a message, and hit Enter. The response
streams in real-time.

## Configuration

All settings are via environment variables (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5173` | Playground server port |
| `OLLAMA_BASE` | `http://127.0.0.1:11434` | Ollama server URL |
| `STUDIO_BASE` | `http://127.0.0.1:3000` | Future: SVG Studio connector |

## Architecture

The project uses an **adapter pattern** — the UI can talk to different backends
by swapping the active adapter:

| Adapter | Status | Backend |
|---|---|---|
| **Ollama** | ✅ Working | `/api/ollama/*` → Ollama at `:11434` |
| **SVG Studio** | 🔲 Placeholder | `/api/studio/*` → Studio at `:3000` (future) |

Adding a new backend is ~30 lines: implement `health()`, `models()`, and `chat()`
in `public/js/adapter.js`, register it, and add a proxy route in `server/index.mjs`.

## Project Structure

```
llm-agent/
├── server/
│   └── index.mjs          # Node.js static server + reverse proxy
├── public/
│   ├── index.html          # Playground page
│   ├── css/style.css       # Dark theme styles
│   └── js/
│       ├── adapter.js      # Swappable LLM connector registry
│       └── app.js          # UI wiring, streaming, presets
├── models/                 # Local model files (gitignored)
├── .env.example            # Configuration template
└── README.md
```

## Presets

The sidebar ships with five built-in presets:

- **General** — helpful assistant, concise
- **SVG Generator** — outputs raw SVG in code blocks
- **Code Reviewer** — structured code analysis
- **Translator** — pure translation output
- **JSON Builder** — valid JSON only

Customise the `PRESETS` array in `public/js/app.js` to add your own.

---

## Interactive Shell

```bash
svg-agent shell --project fish
```

Once inside, type natural-language instructions:

```
> move eye up 5          # OBVIOUS → previews diff, asks y/N, then PUT
> stroke-width 2         # OBVIOUS → direct apply
> friendlier             # SUBJECTIVE → proposes 3 variants to the option tray
> add wings              # STRUCTURAL → proposes variants
```

**Metacommands** (leading `:`):

| Command | Effect |
|---------|--------|
| `:help` | Show available commands |
| `:project NAME` | Switch target project |
| `:peek` | Print the current SVG to stdout |
| `:elements` | List element `id`s in the current SVG |
| `:clear-history` | Wipe `readline` history |
| `:quit` | Exit the shell |

A background SSE relay surfaces server events (`current-changed`,
`options-changed`, etc.) between prompts.

---

## Configuration

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `SVG_MODEL_PATH` | `models/MiniCPM5-1B-Q4_K_M.gguf` | GGUF model for the embedded LLM |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server (future backend) |
| `OLLAMA_MODEL` | `qwen2.5-coder:3b` | Model name for Ollama |

---

## Model Recommendations

The agent works **without any LLM** for deterministic edits — the workflow
controller classifies instructions and applies structural edits or posts
variant proposals entirely through string operations.

When an LLM is needed (e.g. parsing free-form natural language into structured
edit operands), two backends are available:

### Embedded (`llama-cpp-python`)

- **Pros:** No external process; works offline; single-process deployment.
- **Cons:** ~688 MB model download; slower cold-start; CPU-bound on most hosts.
- **Best for:** Codespace/container deployments, air-gapped environments, demos.
- **Recommended model:** `MiniCPM5-1B-Q4_K_M.gguf` (~688 MB, runs in <1 GB RAM).

### Ollama (HTTP API)

- **Pros:** No native compilation; model management handled by Ollama; faster
  iteration (swap models without rebuilding).
- **Cons:** Requires a running Ollama daemon; network dependency.
- **Best for:** Local development, teams already using Ollama, GPU-equipped hosts.
- **Recommended models:** `qwen2.5-coder:3b`, `llama3.2:3b`, or any small
  instruct-tuned model that handles structured output.

---

## Project Structure

```
svg-agent/
├── pyproject.toml              # deps, build config, entry points
├── Makefile                    # install, download-model, test, lint
├── README.md
├── .env.example
├── models/                     # GGUF files (gitignored)
│   └── MiniCPM5-1B-Q4_K_M.gguf
├── src/svg_agent/
│   ├── __init__.py
│   ├── client.py               # HTTPClient — REST + SSE transport
│   ├── markup.py               # MarkupEngine — deterministic SVG edits
│   ├── workflow.py             # WorkflowController — classify → act loop
│   ├── conventions.py          # ConventionStore — cached server guides
│   ├── llm_backend.py          # EmbeddedLLM (llama-cpp-python)
│   ├── shell.py                # Interactive REPL
│   └── cli.py                  # CLI entrypoint
├── examples/
│   ├── hello_world.py          # Phase 0 — load model, stream greeting
│   ├── batch_edit.py           # Sequential edits via HTTPClient
│   └── variant_proposal.py     # Propose variants, select one
├── docs/
│   └── onboarding.md           # Agent-onboarding guide
└── tests/
    ├── test_llm_backend.py
    ├── test_workflow.py
    ├── test_cli.py
    └── test_shell.py
```

---

## Testing

```bash
pytest -v                      # run all tests
pytest -q                      # concise output
```

Tests run without a live server — HTTP transports are mocked via `httpx`
transports or in-memory fakes. The LLM backend tests skip gracefully when no
model is downloaded.

---

## Linting

```bash
ruff check src/ tests/ examples/
```

---

## Development

```bash
pip install -e ".[dev]"        # install in editable mode
make test                      # pytest -v
make lint                      # ruff check
make clean                     # remove __pycache__, model, .pytest_cache
```

---

## Roadmap

| Milestone | Status |
|-----------|--------|
| M0 — Embed-an-LLM Hello World | ✅ |
| M1 — Core Client + Markup Engine | ✅ |
| M2 — Workflow Controller + Conventions | ✅ |
| M3 — Pluggable LLM Backend | ⏭️ Skipped |
| M4 — Interactive Shell | ✅ |
| M5 — Documentation + Examples | ✅ |

---

## License

TBD