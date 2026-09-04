/**
 * adapter.js — Swappable LLM connector registry.
 *
 * Each adapter exposes:
 *   name        – display label
 *   health(base, model) → Promise<{ ok, info }>
 *   models(base) → Promise<string[]>
 *   chat(base, { model, messages, temp, maxTokens }, onToken) → Promise<void>
 *
 * The proxy routes:
 *   /api/ollama/* → Ollama   (http://127.0.0.1:11434)
 *   /api/studio/* → Studio   (http://127.0.0.1:3000)  [future]
 */

const Adapters = (() => {
  const registry = {};

  function register(id, impl) {
    registry[id] = impl;
  }

  function get(id) {
    return registry[id];
  }

  function list() {
    return Object.entries(registry).map(([id, a]) => ({ id, name: a.name }));
  }

  // ─── Ollama adapter ────────────────────────────────────────
  register("ollama", {
    name: "Ollama",

    async health(base, model) {
      try {
        const r = await fetch(`${base}/api/tags`);
        if (!r.ok) return { ok: false, info: `HTTP ${r.status}` };
        const data = await r.json();
        const names = (data.models || []).map((m) => m.name);
        if (model && !names.some((n) => n.startsWith(model))) {
          return { ok: false, info: `model "${model}" not found` };
        }
        return { ok: true, info: `${names.length} model(s) available` };
      } catch (e) {
        return { ok: false, info: e.message };
      }
    },

    async models(base) {
      try {
        const r = await fetch(`${base}/api/tags`);
        if (!r.ok) return [];
        const data = await r.json();
        return (data.models || []).map((m) => m.name).sort();
      } catch {
        return [];
      }
    },

    async chat(base, { model, messages, temp, topP, maxTokens, signal }, onToken, onDone) {
      const body = {
        model,
        messages,
        stream: true,
        options: {
          temperature: temp,
          top_p: topP,
          num_predict: maxTokens,
        },
      };

      const r = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });

      if (!r.ok) {
        const text = await r.text();
        throw new Error(`Ollama ${r.status}: ${text}`);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.message?.content) onToken(obj.message.content);
            if (obj.done) {
              if (onDone) {
                onDone({
                  promptTokens: obj.prompt_eval_count || 0,
                  completionTokens: obj.eval_count || 0,
                });
              }
              return;
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    },
  });

  // ─── SVG Studio adapter (future placeholder) ──────────────
  register("studio", {
    name: "SVG Studio (:3000)",

    async health(base) {
      try {
        const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (!r.ok) return { ok: false, info: `HTTP ${r.status}` };
        return { ok: true, info: "studio connected" };
      } catch (e) {
        return { ok: false, info: e.message };
      }
    },

    async models() {
      return [];
    },

    async chat(base, { messages, temp, topP, maxTokens, signal }, onToken, onDone) {
      const r = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          temperature: temp,
          top_p: topP,
          max_tokens: maxTokens,
        }),
        signal,
      });

      if (!r.ok) throw new Error(`Studio ${r.status}`);

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let promptTokens = 0;
      let completionTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const token = obj.choices?.[0]?.delta?.content;
            if (token) onToken(token);
            if (obj.usage) {
              promptTokens = obj.usage.prompt_tokens || 0;
              completionTokens = obj.usage.completion_tokens || 0;
            }
            if (obj.choices?.[0]?.finish_reason) {
              if (onDone) onDone({ promptTokens, completionTokens });
              return;
            }
          } catch {
            // skip
          }
        }
      }
      if (onDone) onDone({ promptTokens, completionTokens });
    },
  });

  return { register, get, list };
})();
