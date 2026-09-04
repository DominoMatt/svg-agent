# Agent Onboarding Guide

This guide explains how `llm-agent` works and how to extend it.

---

## Architecture Overview

```
Browser UI (public/) → Node proxy (server/index.mjs) → Ollama (:11434)
                                                        SVG Studio (:3000) [future]
```

The project has **zero npm dependencies** — it uses only Node ≥ 18 built-ins.

---

## Key Concepts

### Adapter Pattern

The UI talks to different backends through a **swappable adapter registry**
defined in `public/js/adapter.js`. Each adapter exposes three methods:

| Method | Purpose |
|---|---|
| `health(base, model)` | Check if the backend is reachable |
| `models(base)` | List available model names |
| `chat(base, opts, onToken)` | Stream a chat completion |

Currently two adapters are registered:

- **ollama** — fully working, streams NDJSON from `/api/chat`
- **studio** — placeholder for future SVG Studio integration on `:3000`

### Reverse Proxy

The Node server (`server/index.mjs`) serves static files from `public/` and
reverse-proxies `/api/*` requests to the appropriate backend:

- `/api/ollama/*` → Ollama at `OLLAMA_BASE` (default `:11434`)
- `/api/studio/*` → Studio at `STUDIO_BASE` (default `:3000`)
- `/api/*` (fallback) → Ollama

This avoids CORS issues — the browser only talks to one origin.

---

## Adding a New Adapter

1. **Register in `public/js/adapter.js`:**

```js
Adapters.register("my-backend", {
  name: "My Backend",
  async health(base, model) { /* ... */ },
  async models(base) { /* ... */ },
  async chat(base, { model, messages, temp, maxTokens }, onToken) { /* ... */ },
});
```

2. **Add a proxy route in `server/index.mjs`:**

```js
if (req.url.startsWith("/api/my-backend/")) {
  req.url = req.url.replace("/api/my-backend", "");
  return proxy(MY_BACKEND_BASE, req, res);
}
```

3. **Update `refreshEndpoint()` in `public/js/app.js`** to set the default
   endpoint for your adapter.

---

## Configuration

All settings are via environment variables (copy `.env.example` to `.env`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5173` | Server port |
| `OLLAMA_BASE` | `http://127.0.0.1:11434` | Ollama URL |
| `STUDIO_BASE` | `http://127.0.0.1:3000` | SVG Studio URL (future) |

---

## Running Locally

```bash
# 1. Ensure Ollama is running with at least one model
ollama pull qwen2.5-coder:3b

# 2. Start the playground
node server/index.mjs

# 3. Open http://localhost:5173
```

---

## Project Files

| File | Purpose |
|---|---|
| `server/index.mjs` | Node.js server + reverse proxy |
| `public/index.html` | Playground page |
| `public/css/style.css` | Dark theme styles |
| `public/js/adapter.js` | Swappable connector registry |
| `public/js/app.js` | UI wiring, streaming, presets |
