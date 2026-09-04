# Agent Onboarding Guide

This guide explains how `svg-agent` feeds conventions to a small (<4B parameter)
language model so it can produce SVG edits that the server will accept.

---

## The Problem

Small models are good at structured text but bad at "making things up" — they
need explicit guardrails. SVG Studio already has guardrails in the form of two
markdown documents served over HTTP:

| Document | Endpoint | Purpose |
|----------|----------|---------|
| `BROWSER_AGENTS.md` | `GET /api/conventions` | Workflow rules — what agents may/may not do |
| `AUTHORING.md` | `GET /api/authoring` | SVG structure guide — naming, nesting, void elements |

When a human works in the browser, these are visible as side-panels. When the
agent works, they are injected into the LLM prompt as **system context**.

---

## Convention Injection Pipeline

```
Agent starts
    │
    ▼
GET /api/conventions  ──→  ConventionStore.conventions()
GET /api/authoring    ──→  ConventionStore.authoring()
    │
    ▼  (fetched once, memoised for the session)
    │
WorkflowController.ensure_context()
    │
    ▼
classify(instruction)
    │
    ├─ OBVIOUS ──────→ MarkupEngine (string ops, no LLM)
    │
    └─ SUBJECTIVE ──→ LLM prompt:
                        [system] conventions + authoring
                        [user]   current SVG + instruction
                        → model produces revised SVG
                        → server validates on PUT
```

### What the LLM sees

A typical prompt to a small model looks like this:

```
SYSTEM:
You are an SVG editing assistant. Follow these conventions strictly:

## Conventions
[BROWSER_AGENTS.md contents — fetched from the server]

## Authoring Guide
[AUTHORING.md contents — fetched from the server]

USER:
Here is the current SVG for project "fish":

<svg viewBox="0 0 100 100">
  <g id="body" fill="orange" stroke="black" stroke-width="1">
    <ellipse id="eye" cx="60" cy="40" rx="8" ry="10" fill="white"/>
    <path id="mouth" d="M 55 55 Q 65 65 55 70" fill="none" stroke="black"/>
  </g>
</svg>

Instruction: make the fish look friendlier

Produce the revised SVG. Output ONLY the <svg> element — no commentary.
```

### Why this works with small models

1. **Short, structured output** — the model only needs to reproduce the SVG with
   minor attribute changes. No long-form prose.
2. **Grounded in conventions** — the system prompt tells the model exactly which
   attributes are valid, how elements should be nested, and what the naming
   scheme is.
3. **Validated on write** — even if the model produces imperfect markup, the
   server rejects malformed SVG on `PUT /current`, so the agent never silently
   corrupts the artwork.

---

## For Agent Developers

If you are building a new agent that talks to SVG Studio, here is the minimal
integration recipe:

### 1. Fetch conventions at startup

```python
import httpx

base = "http://localhost:3000"
conventions = httpx.get(f"{base}/api/conventions").text
authoring = httpx.get(f"{base}/api/authoring").text
```

### 2. Build your prompt

Combine the conventions + authoring + current SVG + user instruction into a
single prompt. Keep it under 2 000 tokens for small models.

### 3. Parse the instruction

Use the LLM (or a regex heuristic) to classify the instruction:

- **OBVIOUS** — measurable, deterministic → apply directly via `PUT /current`
- **SUBJECTIVE** — qualitative, creative → propose variants via `POST /options`
- **STRUCTURAL** — adds/removes elements → propose variants

### 4. Apply or propose

```python
if is_obvious(instruction):
    # Direct edit — no LLM needed
    new_svg = apply_edits(current_svg, instruction)
    httpx.put(f"{base}/api/projects/{project}/current", json={"svg": new_svg})
else:
    # Propose variants
    variants = [{"label": f"variant-{i}", "svg": current_svg} for i in range(3)]
    httpx.post(f"{base}/api/projects/{project}/options", json={"options": variants})
```

### 5. Verify

Re-read the current state and compare. The server is the source of truth —
never trust your local copy after a write.

---

## Tips for Small Models

| Tip | Why |
|-----|-----|
| Keep the SVG under 100 lines | Small models lose coherence past ~500 tokens |
| Use `id` on every element | Makes element targeting unambiguous |
| Include the viewBox | The model needs spatial context to reason about transforms |
| One edit per instruction | Fewer chances for hallucinated side-effects |
| Validate on write | Never assume the model's output is correct |

---

## Model Selection Guide

| Model | Size | RAM | Quality | Notes |
|-------|------|-----|---------|-------|
| `MiniCPM5-1B-Q4_K_M` | ~450 MB | <1 GB | Good for attribute edits | Default; used in hello_world.py |
| `qwen2.5-coder:3b` (Ollama) | ~2 GB | ~3 GB | Better at structural edits | Needs Ollama daemon |
| `llama3.2:3b` (Ollama) | ~2 GB | ~3 GB | Strong general reasoning | Good fallback |
