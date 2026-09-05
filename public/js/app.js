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

  // ─── Harness Tab & Panel ───────────────────────────────────
  const HARNESS_BASE = "/api/harness";
  let currentRunId = null;
  let tracePollTimer = null;

  // DOM refs for harness
  const $tabChat = document.getElementById("tab-chat");
  const $tabHarness = document.getElementById("tab-harness");
  const $panelChat = document.getElementById("panel-chat");
  const $panelHarness = document.getElementById("panel-harness");
  const $harnessGoal = document.getElementById("harness-goal");
  const $harnessStart = document.getElementById("harness-start");
  const $harnessStop = document.getElementById("harness-stop");
  const $harnessRunInfo = document.getElementById("harness-run-info");
  const $harnessRunId = document.getElementById("harness-run-id");
  const $harnessTrace = document.getElementById("harness-trace");
  const $harnessChat = document.getElementById("harness-chat-view")?.querySelector("#harness-chat");
  const $harnessMetrics = document.getElementById("harness-metrics");
  const $harnessRefreshMetrics = document.getElementById("harness-refresh-metrics");

  // Tab switching
  function switchTab(tab) {
    const isHarness = tab === "harness";
    $tabChat.classList.toggle("active", !isHarness);
    $tabHarness.classList.toggle("active", isHarness);
    $tabChat.setAttribute("aria-selected", !isHarness);
    $tabHarness.setAttribute("aria-selected", isHarness);
    $panelChat.classList.toggle("active", !isHarness);
    $panelHarness.classList.toggle("active", isHarness);
    $panelChat.hidden = isHarness;
    $panelHarness.hidden = !isHarness;

    // Show/hide main stage views
    const $history = document.getElementById("history");
    const $harnessChatView = document.getElementById("harness-chat-view");
    const $composer = document.getElementById("composer");
    if (isHarness) {
      $history.hidden = true;
      $harnessChatView.hidden = false;
      $composer.hidden = true;
    } else {
      $history.hidden = false;
      $harnessChatView.hidden = true;
      $composer.hidden = false;
    }
  }

  $tabChat.addEventListener("click", () => switchTab("chat"));
  $tabHarness.addEventListener("click", () => switchTab("harness"));

  // Start harness run
  async function startHarnessRun() {
    const goal = $harnessGoal.value.trim();
    if (!goal) return;

    $harnessStart.disabled = true;
    $harnessStart.textContent = "Starting…";

    try {
      const res = await fetch(`${HARNESS_BASE}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start run");

      currentRunId = data.runId;
      $harnessRunId.textContent = currentRunId;
      $harnessRunInfo.hidden = false;
      $harnessStart.hidden = true;
      $harnessStop.hidden = false;

      // Clear previous run's chat before rendering the new run
      $harnessChat.innerHTML = "";

      // Start polling trace
      pollTrace();
    } catch (err) {
      alert("Failed to start run: " + err.message);
      $harnessStart.disabled = false;
      $harnessStart.textContent = "▶ Start Run";
    }
  }

  // Stop harness run
  function stopHarnessRun() {
    if (tracePollTimer) {
      clearInterval(tracePollTimer);
      tracePollTimer = null;
    }
    currentRunId = null;
    $harnessRunInfo.hidden = true;
    $harnessStart.hidden = false;
    $harnessStop.hidden = true;
    $harnessStart.disabled = false;
    $harnessStart.textContent = "▶ Start Run";
    $harnessTrace.innerHTML = '<div class="trace-empty">Run stopped. Start a new pipeline to see trace.</div>';
    $harnessChat.innerHTML = '<div class="chat-empty">No active run. Start a pipeline to see chat.</div>';
  }

  $harnessStart.addEventListener("click", startHarnessRun);
  $harnessStop.addEventListener("click", stopHarnessRun);

  // Poll trace
  async function pollTrace() {
    if (!currentRunId) return;

    try {
      const res = await fetch(`${HARNESS_BASE}/trace/${currentRunId}`);
      const data = await res.json();
      if (res.ok) {
        renderTrace(data.trace);
        renderChat(data.trace);
      }
    } catch (err) {
      console.error("Trace poll error:", err);
    }

    tracePollTimer = setTimeout(pollTrace, 2000);
  }

  // Render trace
  function renderTrace(trace) {
    if (!trace || trace.length === 0) {
      $harnessTrace.innerHTML = '<div class="trace-empty">Waiting for steps…</div>';
      return;
    }

    // Preserve expanded steps and scroll position across re-renders
    const expanded = new Set();
    $harnessTrace.querySelectorAll(".trace-step.expanded").forEach(el => {
      expanded.add(el.dataset.step);
    });
    const prevScrollTop = $harnessTrace.scrollTop;

    $harnessTrace.innerHTML = "";
    trace.forEach(step => {
      const div = document.createElement("div");
      div.className = "trace-step";
      div.dataset.step = step.step;
      if (expanded.has(String(step.step))) div.classList.add("expanded");

      const statusClass = step.status === "ok" ? "ok" : step.status === "error" ? "error" : "pending";
      const statusText = step.status === "ok" ? "✓" : step.status === "error" ? "✗" : "⟳";

      div.innerHTML = `
        <div class="trace-step-header">
          <span class="trace-step-num">${step.step}</span>
          <span class="trace-step-actor">${escapeHtml(step.actor)}</span>
          <span class="trace-step-status ${statusClass}">${statusText} ${escapeHtml(step.eventType || step.status)}</span>
        </div>
        <div class="trace-step-details">
          <div class="trace-step-detail-row">
            <span class="trace-step-detail-label">Status:</span>
            <span class="trace-step-detail-value">${escapeHtml(step.status)}</span>
          </div>
          ${step.children && step.children.length ? `
            <div class="trace-step-detail-row">
              <span class="trace-step-detail-label">Children:</span>
              <span class="trace-step-detail-value">${step.children.join(", ")}</span>
            </div>
          ` : ""}
          ${step.metadata ? `
            <div class="trace-step-detail-row">
              <span class="trace-step-detail-label">Duration:</span>
              <span class="trace-step-detail-value">${step.metadata.durationMs ? step.metadata.durationMs + "ms" : "—"}</span>
            </div>
            <div class="trace-step-detail-row">
              <span class="trace-step-detail-label">Model:</span>
              <span class="trace-step-detail-value">${escapeHtml(step.metadata.model || "—")}</span>
            </div>
            <div class="trace-step-detail-row">
              <span class="trace-step-detail-label">Tokens (est):</span>
              <span class="trace-step-detail-value">${step.metadata.tokensEstimated ? step.metadata.tokensEstimated.toLocaleString() : "—"}</span>
            </div>
          ` : ""}
          <div class="trace-step-actions">
            <button class="btn secondary" type="button" data-action="view-blob" data-cid="${step.payloadRef || ""}">View Output</button>
            <button class="btn secondary" type="button" data-action="replay" data-step="${step.step}">Replay from Here</button>
          </div>
        </div>
      `;

      // Click to expand
      div.querySelector(".trace-step-header").addEventListener("click", () => {
        div.classList.toggle("expanded");
      });

      // View blob
      div.querySelector('[data-action="view-blob"]').addEventListener("click", (e) => {
        e.stopPropagation();
        const cid = e.target.dataset.cid;
        if (cid) viewBlob(cid);
      });

      // Replay
      div.querySelector('[data-action="replay"]').addEventListener("click", (e) => {
        e.stopPropagation();
        const stepNum = parseInt(e.target.dataset.step, 10);
        replayFromStep(stepNum);
      });

      $harnessTrace.appendChild(div);
    });

    $harnessTrace.scrollTop = prevScrollTop;
  }

  // Render chat view (incremental — preserves scroll position)
  function renderChat(trace) {
    if (!trace || trace.length === 0) {
      // Only show the placeholder if there's genuinely nothing rendered yet —
      // never wipe existing pills/messages on a transient empty trace.
      if (!$harnessChat.querySelector(".agent-pill") && !$harnessChat.querySelector(".chat-message")) {
        $harnessChat.innerHTML = '<div class="chat-empty">No active run. Start a pipeline to see chat.</div>';
      }
      return;
    }

    // Remove empty placeholder if present
    const empty = $harnessChat.querySelector(".chat-empty");
    if (empty) empty.remove();

    // Only auto-scroll if the user is already near the bottom (or first render)
    const nearBottom = $harnessChat.scrollHeight - $harnessChat.scrollTop - $harnessChat.clientHeight < 80;
    let appendedNew = false;

    trace.forEach(step => {
      const statusClass = step.status === "ok" ? "ok" : step.status === "error" ? "error" : "pending";
      const isThinking = step.status === "pending" || step.status === "running";

      // Agent pill — create if missing, otherwise update in place
      let pill = $harnessChat.querySelector(`.agent-pill[data-step="${step.step}"]`);
      if (!pill) {
        pill = document.createElement("div");
        pill.className = "agent-pill";
        pill.dataset.step = step.step;
        $harnessChat.appendChild(pill);
        appendedNew = true;
      }
      pill.className = `agent-pill ${isThinking ? "thinking" : ""}`;
      pill.innerHTML = `
        ${isThinking ? '<span class="spinner"></span>' : ''}
        <span class="agent-name">${escapeHtml(step.actor)}</span>
        <span class="pill ${statusClass}">${step.status === "ok" ? "✓" : step.status === "error" ? "✗" : "⟳"} ${escapeHtml(step.eventType || step.status)}</span>
      `;

      // Output message if completed — create once, then leave it alone
      if (step.status === "ok" && step.payloadRef) {
        let msg = $harnessChat.querySelector(`.chat-message[data-step="${step.step}"]`);
        if (!msg) {
          msg = document.createElement("div");
          msg.className = "chat-message agent";
          msg.dataset.step = step.step;
          const duration = step.metadata?.durationMs ? step.metadata.durationMs + "ms" : "";
          const tokens = step.metadata?.tokensEstimated ? step.metadata.tokensEstimated.toLocaleString() + " tokens" : "";
          msg.innerHTML = `
            <div class="chat-message-header">
              <span class="agent-badge">${escapeHtml(step.actor)}</span>
              <span>${duration}</span>
              <span>${tokens}</span>
            </div>
            <div class="chat-message-content" data-cid="${step.payloadRef}"></div>
          `;
          $harnessChat.appendChild(msg);
          appendedNew = true;

          // Fetch and render blob content
          fetchBlobForChat(step.payloadRef, msg.querySelector(".chat-message-content"));
        }
      }
    });

    // Auto-scroll to bottom only when new content was added and user is near the bottom
    if (appendedNew && nearBottom) {
      $harnessChat.scrollTop = $harnessChat.scrollHeight;
    }
  }

  // Fetch and render blob content in chat
  async function fetchBlobForChat(cid, container) {
    try {
      const res = await fetch(`${HARNESS_BASE}/blob/${cid}`);
      const data = await res.json();
      if (res.ok && data.content) {
        try {
          const parsed = JSON.parse(data.content);
          if (parsed.svg) {
            // SVG output - render preview
            container.innerHTML = `
              <pre><code>${escapeHtml(JSON.stringify(parsed, null, 2))}</code></pre>
              <div class="chat-svg-preview">${parsed.svg}</div>
            `;
          } else {
            // JSON output
            container.innerHTML = `<pre><code>${escapeHtml(JSON.stringify(parsed, null, 2))}</code></pre>`;
          }
        } catch {
          // Plain text
          container.textContent = data.content;
        }
      } else {
        container.textContent = "Failed to load output";
      }
    } catch (err) {
      container.textContent = "Error: " + err.message;
    }
  }

  // View blob content
  async function viewBlob(cid) {
    try {
      const res = await fetch(`${HARNESS_BASE}/blob/${cid}`);
      const data = await res.json();
      if (res.ok) {
        alert(`CID: ${cid}\n\n${data.content.slice(0, 2000)}${data.content.length > 2000 ? "\n\n[truncated]" : ""}`);
      } else {
        alert("Failed to load blob: " + (data.error || "Unknown error"));
      }
    } catch (err) {
      alert("Error loading blob: " + err.message);
    }
  }

  // Replay from step
  async function replayFromStep(step) {
    if (!currentRunId) return;
    if (!confirm(`Replay from step ${step}? This will re-run this step and all subsequent steps.`)) return;

    try {
      const res = await fetch(`${HARNESS_BASE}/replay/${currentRunId}/${step}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Replay failed");
      alert("Replay started. Trace will update shortly.");
    } catch (err) {
      alert("Replay failed: " + err.message);
    }
  }

  // Refresh metrics
  async function refreshMetrics() {
    try {
      const res = await fetch(`${HARNESS_BASE}/metrics`);
      const data = await res.json();
      if (res.ok) {
        $harnessMetrics.textContent = JSON.stringify(data, null, 2);
      }
    } catch (err) {
      $harnessMetrics.textContent = "Error: " + err.message;
    }
  }

  $harnessRefreshMetrics.addEventListener("click", refreshMetrics);

  // ─── Run History ───────────────────────────────────────────
  const $harnessRuns = document.getElementById("harness-runs");
  const $harnessRefreshRuns = document.getElementById("harness-refresh-runs");

  async function loadRuns() {
    try {
      const res = await fetch(`${HARNESS_BASE}/runs`);
      const data = await res.json();
      if (res.ok) {
        renderRuns(data.runs);
      }
    } catch (err) {
      $harnessRuns.innerHTML = '<div class="trace-empty">Error loading runs</div>';
    }
  }

  function renderRuns(runs) {
    if (!runs || runs.length === 0) {
      $harnessRuns.innerHTML = '<div class="trace-empty">No runs yet.</div>';
      return;
    }

    $harnessRuns.innerHTML = "";
    runs.forEach(run => {
      const div = document.createElement("div");
      div.className = "run-item";
      div.dataset.runId = run.runId;

      const statusClass = run.status || "pending";
      const startedAt = new Date(run.startedAt).toLocaleTimeString();
      const updatedAt = new Date(run.updatedAt).toLocaleTimeString();

      div.innerHTML = `
        <div class="run-item-header">
          <span class="run-item-id">${run.runId.slice(0,8)}…</span>
          <span class="run-item-status ${statusClass}">${statusClass}</span>
        </div>
        <div class="run-item-meta">
          <span>${run.stepCount} steps</span>
          <span>${run.actors.join(", ")}</span>
          <span>${startedAt} → ${updatedAt}</span>
        </div>
        <div class="run-item-actions">
          <button class="btn secondary" type="button" data-action="load-trace">Load Trace</button>
          <button class="btn secondary" type="button" data-action="export">Export</button>
        </div>
      `;

      div.querySelector('[data-action="load-trace"]').addEventListener("click", (e) => {
        e.stopPropagation();
        loadTraceForRun(run.runId);
      });

      div.querySelector('[data-action="export"]').addEventListener("click", async (e) => {
        e.stopPropagation();
        await exportRun(run.runId);
      });

      $harnessRuns.appendChild(div);
    });
  }

  async function loadTraceForRun(runId) {
    currentRunId = runId;
    $harnessRunId.textContent = runId;
    $harnessRunInfo.hidden = false;
    $harnessStart.hidden = true;
    $harnessStop.hidden = false;
    switchTab("harness");
    await pollTrace();
  }

  $harnessRefreshRuns.addEventListener("click", loadRuns);

  // ─── Dead Letters ──────────────────────────────────────────
  const $harnessDeadLetters = document.getElementById("harness-dead-letters");
  const $harnessRefreshDead = document.getElementById("harness-refresh-dead");

  async function loadDeadLetters() {
    try {
      const res = await fetch(`${HARNESS_BASE}/dead-letter`);
      const data = await res.json();
      if (res.ok) {
        renderDeadLetters(data.deadLetters);
      }
    } catch (err) {
      $harnessDeadLetters.innerHTML = '<div class="trace-empty">Error loading dead letters</div>';
    }
  }

  function renderDeadLetters(deadLetters) {
    if (!deadLetters || deadLetters.length === 0) {
      $harnessDeadLetters.innerHTML = '<div class="trace-empty">No dead letters.</div>';
      return;
    }

    $harnessDeadLetters.innerHTML = "";
    deadLetters.forEach(dl => {
      const div = document.createElement("div");
      div.className = "dead-letter-item";

      const time = new Date(dl.timestamp).toLocaleTimeString();

      div.innerHTML = `
        <div class="dead-letter-header">
          <span class="dead-letter-actor">${escapeHtml(dl.actor)}</span>
          <span>${dl.runId.slice(0,8)}… step ${dl.step}</span>
          <span style="margin-left:auto;color:var(--dim);font-size:10px">${time}</span>
        </div>
        <div class="dead-letter-error">${escapeHtml(dl.error || "Unknown error")}</div>
        <div class="dead-letter-actions">
          <button class="btn secondary" type="button" data-action="retry">Retry</button>
        </div>
      `;

      div.querySelector('[data-action="retry"]').addEventListener("click", async () => {
        try {
          const res = await fetch(`${HARNESS_BASE}/dead-letter/retry`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: dl.runId, step: dl.step, actor: dl.actor }),
          });
          if (res.ok) {
            alert("Retry queued");
            loadDeadLetters();
          }
        } catch (err) {
          alert("Retry failed: " + err.message);
        }
      });

      $harnessDeadLetters.appendChild(div);
    });
  }

  $harnessRefreshDead.addEventListener("click", loadDeadLetters);

  // ─── Export / Import ───────────────────────────────────────
  const $harnessExport = document.getElementById("harness-export");
  const $harnessImport = document.getElementById("harness-import");
  const $harnessImportFile = document.getElementById("harness-import-file");

  async function exportRun(runId) {
    try {
      const res = await fetch(`${HARNESS_BASE}/export/${runId}`);
      const data = await res.json();
      if (res.ok) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `run-${runId.slice(0,8)}-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        alert("Export failed: " + (data.error || "Unknown error"));
      }
    } catch (err) {
      alert("Export error: " + err.message);
    }
  }

  $harnessExport.addEventListener("click", () => {
    if (currentRunId) exportRun(currentRunId);
    else alert("No active run to export");
  });

  $harnessImport.addEventListener("click", () => {
    $harnessImportFile.click();
  });

  $harnessImportFile.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const importData = JSON.parse(text);

      const res = await fetch(`${HARNESS_BASE}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(importData),
      });
      const data = await res.json();
      if (res.ok) {
        alert("Imported: " + data.runId);
        loadRuns();
        loadDeadLetters();
      } else {
        alert("Import failed: " + (data.error || "Unknown error"));
      }
    } catch (err) {
      alert("Import error: " + err.message);
    }

    e.target.value = "";
  });

  // ─── WebSocket for Live Updates ────────────────────────────
  let ws = null;

  function connectWebSocket() {
    const wsUrl = `ws://${location.host.replace(/:\d+$/, ":5174")}/api/harness/ws`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[Harness] WebSocket connected");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWebSocketMessage(msg);
      } catch (err) {
        console.error("[Harness] WS message error:", err);
      }
    };

    ws.onclose = () => {
      console.log("[Harness] WebSocket disconnected, reconnecting in 3s…");
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
      console.error("[Harness] WebSocket error:", err);
    };
  }

  function handleWebSocketMessage(msg) {
    switch (msg.type) {
      case "enqueued":
        if (msg.runId === currentRunId) pollTrace();
        loadRuns();
        break;
      case "started":
        if (msg.runId === currentRunId) pollTrace();
        loadRuns();
        break;
      case "completed":
        if (msg.runId === currentRunId) {
          // Immediately render the completed step's output
          renderCompletedStep(msg);
          pollTrace();
        }
        loadRuns();
        break;
      case "failed":
        if (msg.runId === currentRunId) pollTrace();
        loadRuns();
        loadDeadLetters();
        break;
      case "queue-empty":
        loadRuns();
        break;
      case "connected":
        console.log("[Harness] WS ready");
        break;
    }
  }

  // Render a completed step immediately in the chat view
  async function renderCompletedStep(msg) {
    const { runId, step, actor, duration, result } = msg;
    if (!result || !result.outputCid) return;

    // Only auto-scroll if the user is already near the bottom
    const nearBottom = $harnessChat.scrollHeight - $harnessChat.scrollTop - $harnessChat.clientHeight < 80;

    // Find or create the agent pill
    let pill = $harnessChat.querySelector(`.agent-pill[data-step="${step}"]`);
    if (!pill) {
      pill = document.createElement("div");
      pill.className = "agent-pill";
      pill.dataset.step = step;
      pill.innerHTML = `
        <span class="agent-name">${escapeHtml(actor)}</span>
        <span class="pill ok">✓ ${escapeHtml(result.eventTypes?.[0] || "completed")}</span>
      `;
      $harnessChat.appendChild(pill);
    } else {
      pill.classList.remove("thinking");
      pill.innerHTML = `
        <span class="agent-name">${escapeHtml(actor)}</span>
        <span class="pill ok">✓ ${escapeHtml(result.eventTypes?.[0] || "completed")}</span>
      `;
    }

    // Create message container for output
    let msgDiv = $harnessChat.querySelector(`.chat-message[data-step="${step}"]`);
    if (!msgDiv) {
      msgDiv = document.createElement("div");
      msgDiv.className = "chat-message agent";
      msgDiv.dataset.step = step;
      const durationStr = duration ? duration + "ms" : "";
      const tokens = result.tokensEstimated ? result.tokensEstimated.toLocaleString() + " tokens" : "";
      msgDiv.innerHTML = `
        <div class="chat-message-header">
          <span class="agent-badge">${escapeHtml(actor)}</span>
          <span>${durationStr}</span>
          <span>${tokens}</span>
        </div>
        <div class="chat-message-content" data-cid="${result.outputCid}"></div>
      `;
      $harnessChat.appendChild(msgDiv);
    }

    // Fetch and render blob content
    const container = msgDiv.querySelector(".chat-message-content");
    await fetchBlobForChat(result.outputCid, container);

    if (nearBottom) {
      $harnessChat.scrollTop = $harnessChat.scrollHeight;
    }
  }

  // Connect WebSocket when on harness tab
  const originalSwitchTab = switchTab;
  switchTab = function(tab) {
    originalSwitchTab(tab);
    if (tab === "harness") {
      loadRuns();
      loadDeadLetters();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      }
    }
  };

  // Initial loads
  refreshMetrics();
  loadRuns();
  loadDeadLetters();

  initAdapters();
  renderPresets();
  $sysPrompt.value = PRESETS[activePreset].system;
  renderEmpty();
  updateTemp();
  updateTopP();
  startStatusPolling();
})();
