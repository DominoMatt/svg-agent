# llm-agent — Project Plan

## Current State: Web Playground ✅

A local LLM playground with a Node.js proxy server and a browser UI. Connects to
Ollama for model inference with zero npm dependencies.

```
Browser → Node proxy (:5173) → Ollama (:11434)
                               → SVG Studio (:3000) [future]
```

---

## Architecture Decisions

- **No build step** — plain HTML/CSS/JS, no bundler, no TypeScript compilation
- **No npm dependencies** — Node ≥ 18 native `fetch` + `http` module only
- **Adapter pattern** — swappable backends registered in `public/js/adapter.js`
- **Reverse proxy** — avoids CORS issues, single origin for the browser

---

## Roadmap

### Phase 1 — ✅ Done

- [x] Node.js static server + Ollama reverse proxy
- [x] Browser playground with streaming chat
- [x] Dark theme UI with sidebar presets
- [x] Adapter registry (Ollama working, Studio placeholder)
- [x] Temperature / max tokens controls
- [x] Connection status polling
- [x] Model list auto-fetch

### Phase 2 — SVG Studio Connector

- [ ] Implement Studio adapter (health, models, chat)
- [ ] Add SVG-specific presets (generate, edit, propose)
- [ ] Expose Studio authoring API through the proxy
- [ ] Canvas preview pane (iframe to Studio)

### Phase 3 — Richer Playground

- [ ] Multi-turn conversation with context window management
- [ ] Conversation history persistence (localStorage)
- [ ] Export chat as markdown
- [ ] System prompt editor (not just presets)
- [ ] Token count estimate in the UI

### Phase 4 — Agent Features

- [ ] Tool-calling support (function definitions in adapter protocol)
- [ ] SVG diff preview (propose → accept/reject workflow)
- [ ] Batch operations (apply multiple edits in sequence)
- [ ] SSE event relay from Studio for live canvas updates

---

## File Manifest

| File | Purpose |
|---|---|
| `server/index.mjs` | Node.js server: static files + /api/* reverse proxy |
| `public/index.html` | Playground page |
| `public/css/style.css` | Dark theme styles |
| `public/js/adapter.js` | Swappable LLM connector registry |
| `public/js/app.js` | UI wiring, streaming, presets |
| `.env.example` | Environment config template |
| `models/` | Local model files (gitignored) |
