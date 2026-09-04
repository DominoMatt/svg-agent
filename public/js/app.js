/**
 * app.js — Playground UI wiring.
 *
 * Handles: preset rendering, form submission, streaming response rendering,
 * model list fetching, connection status polling, textarea auto-resize.
 */
(() => {
  "use strict";

  // ─── Preset templates ──────────────────────────────────────
  const PRESETS = [
    {
      tag: "General",
      system: "Be concise. Review the full conversation history above before replying—answer using what was discussed earlier when relevant.",
    },
    {
      tag: "SVG Generator",
      system:
        "You are an SVG artist. When asked to create or modify SVG, output ONLY the raw SVG markup inside an ```svg code block. No commentary outside the block. Always reference the full conversation history for context.",
    },
    {
      tag: "Code Reviewer",
      system:
        "You are a senior code reviewer. Analyze the user's code for bugs, performance issues, and style. Be specific and constructive. Use the full conversation history for context.",
    },
    {
      tag: "Translator",
      system:
        "You are a professional translator. Translate the user's text to the target language. Output only the translation, no explanations. Always reference prior messages for context.",
    },
    {
      tag: "JSON Builder",
      system:
        "You are a JSON assistant. Output valid JSON only. Wrap in ```json code blocks. Use the full conversation history for context.",
    },
  ];

  // ─── DOM refs ──────────────────────────────────────────────
  const $presetList = document.getElementById("preset-list");
  const $adapterSel = document.getElementById("adapter");
  const $endpoint = document.getElementById("endpoint");
  const $model = document.getElementById("model");
  const $sysPrompt = document.getElementById("sysPrompt");
  const $status = document.getElementById("status");
  const $tokenCounter = document.getElementById("tokenCounter");
  const $tempSlider = document.getElementById("temp");
  const $tempOut = document.getElementById("tempOut");
  const $topPSlider = document.getElementById("topP");
  const $topPOut = document.getElementById("topPOut");
  const $maxTokens = document.getElementById("maxTokens");
  const $history = document.getElementById("history");
  const $composer = document.getElementById("composer");
  const $input = document.getElementById("input");
  const $send = document.getElementById("send");
  const $reset = document.getElementById("reset");
  const $reconnect = document.getElementById("reconnect");
  const $compact = document.getElementById("compact");
  const $stop = document.getElementById("stop");

  // ─── State ─────────────────────────────────────────────────
  let messages = [];
  let activePreset = 0;
  let sending = false;
  let abortController = null;
  let cumulativeTokens = 0;

  // ─── Token counter helpers ─────────────────────────────────
  // Rough estimator: ~1 token per 4 chars for English
  function estimateTokens(text) {
    return Math.ceil(text.length / 4);
  }

  function updateTokenDisplay(current, max) {
    $tokenCounter.textContent = `${current.toLocaleString()} / ${max.toLocaleString()} tokens`;
  }

  function showTokenCounter(show) {
    $tokenCounter.classList.toggle("hidden", !show);
  }

  function resetTokenCounter(maxTokens) {
    updateTokenDisplay(0, maxTokens);
    showTokenCounter(true);
  }

  // ─── Init adapter dropdown ─────────────────────────────────
  function initAdapters() {
    const adapters = Adapters.list();
    $adapterSel.innerHTML = "";
    adapters.forEach((a) => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = a.name;
      $adapterSel.appendChild(opt);
    });
    $adapterSel.addEventListener("change", () => refreshEndpoint());
    refreshEndpoint();
  }

  function refreshEndpoint() {
    const id = $adapterSel.value;
    if (id === "ollama") {
      $endpoint.value = "/api/ollama";
    } else if (id === "studio") {
      $endpoint.value = "/api/studio";
    }
    checkStatus();
    refreshModels();
  }

  // ─── Model list ────────────────────────────────────────────
  async function refreshModels() {
    const adapter = Adapters.get($adapterSel.value);
    if (!adapter) return;
    const base = $endpoint.value;
    const models = await adapter.models(base);
    if (models.length) {
      $model.value = models[0];
      $model.setAttribute("placeholder", models[0]);
    } else {
      $model.value = "";
      $model.setAttribute("placeholder", "model name");
    }
  }

  // ─── Connection status ─────────────────────────────────────
  let statusTimer = null;

  async function checkStatus() {
    const adapter = Adapters.get($adapterSel.value);
    if (!adapter) return;
    const base = $endpoint.value;
    $status.className = "pill neutral";
    $status.textContent = "connecting…";
    try {
      const result = await adapter.health(base, $model.value);
      if (result.ok) {
        $status.className = "pill ok";
        $status.textContent = result.info;
      } else {
        $status.className = "pill warn";
        $status.textContent = result.info;
      }
    } catch (e) {
      $status.className = "pill warn";
      $status.textContent = e.message;
    }
  }

  function startStatusPolling() {
    checkStatus();
    statusTimer = setInterval(checkStatus, 15000);
  }

  // ─── Preset rendering ──────────────────────────────────────
  function renderPresets() {
    $presetList.innerHTML = "";
    PRESETS.forEach((p, i) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = `${p.tag}<span class="tag">${p.system.slice(0, 48)}…</span>`;
      if (i === activePreset) btn.classList.add("active");
      btn.addEventListener("click", () => {
        activePreset = i;
        $sysPrompt.value = p.system;
        renderPresets();
      });
      li.appendChild(btn);
      $presetList.appendChild(li);
    });
  }

  // ─── History rendering ─────────────────────────────────────
  function renderEmpty() {
    $history.innerHTML = `<li class="empty">Pick a preset and ask anything<br><kbd>Enter</kbd> to send</li>`;
  }

  function addRow(role, text) {
    // Remove empty placeholder
    const empty = $history.querySelector(".empty");
    if (empty) empty.remove();

    const li = document.createElement("li");
    li.className = `row ${role === "user" ? "right" : "left"}`;
    const div = document.createElement("div");
    div.className = "bubble";
    div.innerHTML = `<span class="who">${role === "user" ? "You" : "Assistant"}</span>${escapeHtml(text)}`;
    li.appendChild(div);
    $history.appendChild(li);
    $history.scrollTop = $history.scrollHeight;
    return div;
  }

  function addStreamingRow() {
    const empty = $history.querySelector(".empty");
    if (empty) empty.remove();

    const li = document.createElement("li");
    li.className = "row left";
    const div = document.createElement("div");
    div.className = "bubble";
    div.innerHTML = `<span class="who">Assistant</span><span class="text"></span><span class="caret"></span>`;
    li.appendChild(div);
    $history.appendChild(li);
    $history.scrollTop = $history.scrollHeight;
    return div;
  }

  function finalizeStream(row, text) {
    const caret = row.querySelector(".caret");
    if (caret) caret.remove();
    const span = row.querySelector(".text");
    if (span) span.textContent = text;
    $history.scrollTop = $history.scrollHeight;
  }

  function addError(text) {
    const li = document.createElement("li");
    li.className = "row left";
    li.innerHTML = `<div class="bubble"><span class="who">Error</span><span class="errnote">${escapeHtml(text)}</span></div>`;
    $history.appendChild(li);
    $history.scrollTop = $history.scrollHeight;
  }

  // ─── Submit ────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    if (sending) return;

    const text = $input.value.trim();
    if (!text) return;

    // Build messages — keep history for multi-turn memory
    const system = ($sysPrompt.value || "").trim() ||
                   PRESETS[activePreset].system;
    if (messages.length === 0 || messages[0].role !== "system" || messages[0].content !== system) {
      messages = [{ role: "system", content: system }];
    }
    messages.push({ role: "user", content: text });

    // Show user message
    addRow("user", text);
    $input.value = "";
    autoResize();

    // Stream response
    sending = true;
    $send.disabled = true;
    $send.classList.add("spinning");
    abortController = new AbortController();
    $stop.classList.add("visible");

    const row = addStreamingRow();
    let full = "";

    try {
      const adapter = Adapters.get($adapterSel.value);
      const base = $endpoint.value;
      const model = $model.value;
      const temp = parseFloat($tempSlider.value);
      const topP = parseFloat($topPSlider.value);
      const maxTokens = parseInt($maxTokens.value, 10);

      // Show cumulative tokens from previous responses
      showTokenCounter(true);
      updateTokenDisplay(cumulativeTokens, maxTokens);

      await adapter.chat(
        base,
        { model, messages, temp, topP, maxTokens, signal: abortController.signal },
        (token) => {
          full += token;
          const span = row.querySelector(".text");
          if (span) span.textContent = full;
          // Update estimated tokens during streaming (cumulative + current)
          updateTokenDisplay(cumulativeTokens + estimateTokens(full), maxTokens);
          $history.scrollTop = $history.scrollHeight;
        },
        (stats) => {
          // Update with actual token counts when stream completes
          if (stats.completionTokens > 0) {
            cumulativeTokens += stats.completionTokens;
            updateTokenDisplay(cumulativeTokens, maxTokens);
          }
        }
      );

      finalizeStream(row, full);
      messages.push({ role: "assistant", content: full });
    } catch (err) {
      finalizeStream(row, full || "");
      if (err.name !== "AbortError" && !full) addError(err.message);
    } finally {
      sending = false;
      abortController = null;
      $send.disabled = false;
      $send.classList.remove("spinning");
      $stop.classList.remove("visible");
    }
  }

  // ─── Textarea auto-resize ──────────────────────────────────
  function autoResize() {
    $input.style.height = "auto";
    $input.style.height = Math.min($input.scrollHeight, 320) + "px";
  }

  // ─── Temp slider display ───────────────────────────────────
  function updateTemp() {
    $tempOut.textContent = parseFloat($tempSlider.value).toFixed(2);
  }

  // ─── Top-p slider display ──────────────────────────────────
  function updateTopP() {
    $topPOut.textContent = parseFloat($topPSlider.value).toFixed(2);
  }

  // ─── Reset ─────────────────────────────────────────────────
  function handleReset() {
    messages = [];
    cumulativeTokens = 0;
    renderEmpty();
    $input.value = "";
    autoResize();
    showTokenCounter(false);
    $input.focus();
  }

  // ─── Compact ───────────────────────────────────────────────
  async function handleCompact() {
    if (sending) return;
    // Need at least system + 2 user messages to compact
    if (messages.length < 3) return;

    sending = true;
    $compact.disabled = true;

    const system = messages[0];
    const conversation = messages.slice(1);

    const compactPrompt = [
      { role: "system", content: "You are a conversation summarizer. Summarize the following conversation between a user and an assistant into a concise but complete summary. Preserve all key facts, decisions, code snippets, technical details, and unanswered questions. The summary will replace the conversation history to save context space. Output ONLY the summary, no preamble." },
      { role: "user", content: JSON.stringify(conversation, null, 2) },
    ];

    const row = addStreamingRow();
    let summary = "";

    try {
      const adapter = Adapters.get($adapterSel.value);
      const base = $endpoint.value;
      const model = $model.value;
      const temp = parseFloat($tempSlider.value);
      const topP = parseFloat($topPSlider.value);

      await adapter.chat(
        base,
        { model, messages: compactPrompt, temp, topP, maxTokens: 2048 },
        (token) => {
          summary += token;
          const span = row.querySelector(".text");
          if (span) span.textContent = summary;
          $history.scrollTop = $history.scrollHeight;
        }
      );

      finalizeStream(row, summary);

      // Replace conversation history with condensed summary
      messages = [
        system,
        { role: "user", content: `[Conversation Summary]\n${summary}` },
      ];

      // Re-render history as a single compacted message
      renderEmpty();
      const summaryRow = addRow("assistant", `⊟ Conversation compacted (${conversation.length} messages summarized)\n\n${summary}`);

      $history.scrollTop = $history.scrollHeight;
    } catch (err) {
      finalizeStream(row, summary || "");
      if (!summary) addError("Compact failed: " + err.message);
    } finally {
      sending = false;
      $compact.disabled = false;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────
  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  // ─── Keyboard ──────────────────────────────────────────────
  $input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $composer.requestSubmit();
    }
  });

  // ─── Wire up ───────────────────────────────────────────────
  $composer.addEventListener("submit", handleSubmit);
  $tempSlider.addEventListener("input", updateTemp);
  $topPSlider.addEventListener("input", updateTopP);
  $input.addEventListener("input", autoResize);
  $reset.addEventListener("click", handleReset);
  $reconnect.addEventListener("click", () => {
    checkStatus();
    refreshModels();
  });
  $compact.addEventListener("click", handleCompact);
  $stop.addEventListener("click", () => {
    if (abortController) abortController.abort();
  });

  initAdapters();
  renderPresets();
  $sysPrompt.value = PRESETS[activePreset].system;
  renderEmpty();
  updateTemp();
  updateTopP();
  startStatusPolling();
})();
