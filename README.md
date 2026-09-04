# svg-agent

A lightweight Python agent that manipulates SVG artwork through the
[SVG Studio](https://github.com/DominoMatt/svg-studio) HTTP API. It reads
conventions, composes or edits SVG markup, and pushes changes through the same
endpoints a browser would use — no file access, no shell, no browser automation.

```
┌───────────────────────────────────────────────────────────────┐
│                       svg-agent                               │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ HTTPClient │  │ Workflow     │  │ Interactive Shell     │  │
│  │ (httpx)    │  │ Controller   │  │ (REPL + SSE relay)   │  │
│  └─────┬──────┘  └──────┬───────┘  └──────────┬───────────┘  │
│        └────────────────┼──────────────────────┘              │
│                         ▼                                     │
│              SVG Studio Server (:3000)                        │
│              REST + SSE                                      │
└───────────────────────────────────────────────────────────────┘
```

**Key features:**

- **Deterministic edits** — measurable instructions ("stroke-width 2", "move eye
  up 5") are applied directly via `PUT /current`, with a diff preview + confirmation
  in the interactive shell.
- **Variant proposals** — subjective instructions ("friendlier", "warmer") generate
  a palette of options for the operator to pick from in the browser.
- **Interactive shell** — a REPL with coloured output, `readline` history, SSE event
  relay, and metacommands for project switching and canvas inspection.
- **Version control** — commit, rollback, and undo through the server's version API.
- **Embedded LLM** (optional) — an in-process GGUF model via `llama-cpp-python` for
  prompt-to-instruction parsing; pure-stdlib fallback when no model is present.

---

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/DominoMatt/svg-agent.git
cd svg-agent
pip install -e ".[dev]"        # runtime + test deps
```

### 2. Download the model (optional — for embedded LLM features)

```bash
make download-model            # ~450 MB into models/
```

### 3. Verify — Hello World

```bash
python examples/hello_world.py
```

You should see a streamed greeting from the in-process model, then a clean exit.

### 4. Connect to SVG Studio

Start [SVG Studio](https://github.com/DominoMatt/svg-studio) on its default port
(:3000), then try a one-shot edit:

```bash
svg-agent edit fish SET:eye.fill=blue --server http://localhost:3000
```

Or jump into the interactive shell:

```bash
svg-agent shell fish --server http://localhost:3000
```

---

## CLI Reference

All verbs accept `--server BASE_URL` (default `http://localhost:3000`).

| Verb | Usage | What it does |
|------|-------|-------------|
| `chat` | `svg-agent chat "Greet me."` | Stream a reply from the embedded model |
| `edit` | `svg-agent edit fish SET:eye.fill=red` | Apply structural edits (SET/DROP/TX/BEFORE/AFTER) |
| `propose` | `svg-agent propose fish "warmer colors"` | Route through the workflow controller → option tray |
| `commit` | `svg-agent commit fish --label v1` | Freeze current SVG as a labelled version |
| `rollback` | `svg-agent rollback fish v003-label` | Restore a previous version |
| `undo` | `svg-agent undo fish` | Swap current ↔ previous state |
| `shell` | `svg-agent shell fish` | Enter the interactive REPL |

### Structural edit operands (`edit`)

| Operand | Example | Effect |
|---------|---------|--------|
| `SET:elem.attr=value` | `SET:eye.fill=blue` | Set an attribute |
| `DROP:elem.attr` | `DROP:body.stroke` | Remove an attribute |
| `TX:elem.TRANSFORM` | `TX:eye.translate(0,-5)` | Prepend to transform |
| `BEFORE:elem.<MARKUP>` | `BEFORE:eye.<circle …/>` | Insert sibling before |
| `AFTER:elem.<MARKUP>` | `AFTER:eye.<circle …/>` | Insert sibling after |

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
- **Cons:** ~450 MB model download; slower cold-start; CPU-bound on most hosts.
- **Best for:** Codespace/container deployments, air-gapped environments, demos.
- **Recommended model:** `MiniCPM5-1B-Q4_K_M.gguf` (~450 MB, runs in <1 GB RAM).

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