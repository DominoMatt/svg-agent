/**
 * runner.mjs — Generic Actor Runner
 *
 * Loads manifest → builds prompt → calls Ollama → validates → emits event
 * Zero per-actor code. All behavior defined in manifest YAML.
 */

import { loadManifest, validateInput, validateOutput } from "../server/manifest.mjs";
import { resolveModel, getModelEndpoint, getModelTag, getModelContextWindow } from "../server/modelRegistry.mjs";
import { putBlob, getBlob, compactBlob } from "../server/blobs.mjs";
import { appendEvent } from "../server/log.mjs";
import { randomUUID } from "node:crypto";

const OLLAMA_TIMEOUT = 30000;
const DEFAULT_MAX_CONTEXT_TOKENS = 4096;

export async function runActor(actorName, envelope) {
  const startTime = Date.now();
  const manifest = await loadManifest(actorName);

  // Validate input
  const inputValidation = validateInput(manifest, envelope.payload);
  if (!inputValidation.valid) {
    throw new Error(`Input validation failed for ${actorName}: ${inputValidation.error}`);
  }

  // Resolve model
  const modelInfo = await resolveModel(manifest.model);
  const endpoint = modelInfo.endpoint;
  const modelTag = modelInfo.modelTag;
  const contextWindow = modelInfo.contextWindow || DEFAULT_MAX_CONTEXT_TOKENS;

  // Build context from contextRefs with compaction
  let context = "";
  const contextRefs = envelope.contextRefs || [];
  if (contextRefs.length > 0) {
    const contextParts = [];
    let totalTokens = 0;
    const maxContextTokens = manifest.maxContextTokens || Math.floor(contextWindow * 0.5);

    for (const ref of contextRefs) {
      let content = await getBlob(ref);
      if (!content) continue;

      // Compact if needed
      const estimatedTokens = estimateTokens(content);
      if (totalTokens + estimatedTokens > maxContextTokens) {
        content = await compactBlob(ref, maxContextTokens - totalTokens, manifest.model);
        if (!content) continue;
      }

      contextParts.push(`[${ref}]\n${content}`);
      totalTokens += estimateTokens(content);
    }
    context = contextParts.join("\n\n---\n\n");
  }

  // Build messages for Ollama
  const messages = buildMessages(manifest, context, envelope.payload);

  // Call Ollama (with streaming support for long outputs)
  const response = await callOllama(endpoint, modelTag, messages, manifest, modelInfo);

  // Validate output
  let parsedOutput;
  try {
    parsedOutput = JSON.parse(response);
  } catch {
    // If not JSON, wrap as string
    parsedOutput = response;
  }

  const outputValidation = validateOutput(manifest, parsedOutput);
  if (!outputValidation.valid) {
    const err = new Error(`Output validation failed for ${actorName}: ${outputValidation.error}`);
    err.rawOutput = response;
    throw err;
  }

  // Store output blob
  const outputStr = typeof parsedOutput === "string" ? parsedOutput : JSON.stringify(parsedOutput, null, 2);
  const outputCid = await putBlob(outputStr);

  // Emit event(s)
  for (const eventType of manifest.emits) {
    await appendEvent({
      runId: envelope.runId,
      step: envelope.step,
      actor: actorName,
      eventType,
      payloadRef: outputCid,
      status: "ok",
      parentStep: envelope.parentStep,
      metadata: {
        durationMs: Date.now() - startTime,
        model: modelTag,
        tokensEstimated: estimateTokens(outputStr)
      }
    });
  }

  return { output: parsedOutput, outputCid, eventTypes: manifest.emits, durationMs: Date.now() - startTime };
}

function buildMessages(manifest, context, payload) {
  const messages = [
    { role: "system", content: manifest.systemPrompt },
  ];

  if (context) {
    messages.push({ role: "user", content: `Context:\n${context}` });
  }

  // Format payload based on schema type
  const payloadStr = formatPayloadForPrompt(payload, manifest.inputSchema);
  messages.push({ role: "user", content: payloadStr });

  return messages;
}

function formatPayloadForPrompt(payload, schema) {
  // For object schemas, format as structured prompt
  if (schema?.type === "object" && schema.properties) {
    const lines = [];
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in payload) {
        const desc = propSchema.description ? ` (${propSchema.description})` : "";
        lines.push(`${key}${desc}: ${JSON.stringify(payload[key])}`);
      }
    }
    return lines.join("\n");
  }
  return JSON.stringify(payload, null, 2);
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Decide whether a `"` inside a string is a real terminator or a literal
 * quote (e.g. unescaped quotes in HTML/SVG markup like width="100").
 * A quote is a terminator if followed (past whitespace) by a JSON
 * structural char: , } ] : or end of input.
 */
function isQuoteTerminator(text, i) {
  let j = i + 1;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (j >= text.length) return true;
  const ch = text[j];
  return ch === "," || ch === "}" || ch === "]" || ch === ":";
}

/**
 * Escape literal double quotes that appear inside JSON string values
 * (unescaped quotes from small models embedding markup like SVG).
 */
function escapeUnescapedQuotes(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') {
        if (isQuoteTerminator(text, i)) { out += ch; inString = false; }
        else { out += '\\"'; }
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') { out += ch; inString = true; continue; }
    out += ch;
  }
  return out;
}

/**
 * Extract the first balanced JSON block ({...} or [...]) from text.
 * Handles thinking-model output where the answer is embedded in reasoning.
 * Falls back to best-effort repair for slightly malformed JSON.
 */
function extractJson(text) {
  if (!text) return null;
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  // Direct parse first
  try {
    return JSON.parse(text);
  } catch {}
  // Find first JSON block
  const startIdx = text.search(/[\[{]/);
  if (startIdx === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"' && isQuoteTerminator(text, i)) inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(startIdx, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          // Try repairing unescaped quotes inside string values
          try {
            return JSON.parse(escapeUnescapedQuotes(candidate));
          } catch {
            return null;
          }
        }
      }
    }
  }
  // Unbalanced JSON — attempt best-effort repair
  return repairJson(text.slice(startIdx));
}

/**
 * Fix missing commas between object properties (e.g., `...}] "key":` → `...}], "key":`).
 * Only inserts commas where structurally valid: after `}` or `]` followed by a property key.
 */
function fixMissingCommas(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    out += ch;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{" || ch === "[") { depth++; continue; }
    if (ch === "}" || ch === "]") {
      depth--;
      // Look ahead for next non-whitespace char
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (j < text.length && text[j] === '"') {
        // Next token is a property key — insert comma if not already there
        const prevNonWs = out.trimEnd().slice(-1);
        if (prevNonWs !== "," && prevNonWs !== "{" && prevNonWs !== "[") {
          out += ",";
        }
      }
      continue;
    }
  }
  return out;
}

/**
 * Best-effort repair for slightly malformed JSON: trims trailing garbage
 * and appends missing closing brackets. Bails out on mismatched closers.
 */
function repairJson(raw) {
  const lastClose = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  if (lastClose === -1) return null;
  let candidate = raw.slice(0, lastClose + 1);
  // Fix missing commas between object properties
  candidate = fixMissingCommas(candidate);
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"' && isQuoteTerminator(candidate, i)) inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if ((ch === "}" && open !== "{") || (ch === "]" && open !== "[")) return null;
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    candidate += stack[i] === "{" ? "}" : "]";
  }
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(escapeUnescapedQuotes(candidate));
    } catch {
      return null;
    }
  }
}

/**
 * Extract usable output from an Ollama chat response.
 * Falls back to the `thinking` field for thinking models (e.g. minicpm5)
 * that emit reasoning but leave `content` empty.
 */
export function extractModelOutput(data) {
  const content = data?.message?.content || "";
  if (content.trim()) {
    // Direct parse; if wrapped (e.g. ```json fences), extract the JSON block
    try {
      JSON.parse(content);
      return content;
    } catch {
      const extracted = extractJson(content);
      if (extracted !== null) return JSON.stringify(extracted);
      return content;
    }
  }
  const thinking = data?.message?.thinking || "";
  if (thinking.trim()) {
    const extracted = extractJson(thinking);
    if (extracted !== null) return JSON.stringify(extracted);
    return thinking;
  }
  return "";
}

async function callOllama(endpoint, modelTag, messages, manifest, modelInfo) {
  const body = {
    model: modelTag,
    messages,
    stream: false,
    think: manifest.think ?? modelInfo?.think ?? false,
    options: {
      temperature: manifest.temperature ?? 0.2,
      top_p: manifest.topP ?? 0.9,
      num_predict: manifest.maxTokens ?? 2048,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), manifest.timeoutMs || OLLAMA_TIMEOUT);

  try {
    const response = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama ${response.status}: ${text}`);
    }

    const data = await response.json();
    return extractModelOutput(data);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error(`Actor ${manifest.name} timed out after ${manifest.timeoutMs}ms`);
    }
    throw err;
  }
}

/**
 * Run actor with retries and detailed error tracking
 */
export async function runActorWithRetry(actorName, envelope) {
  const manifest = await loadManifest(actorName);
  const maxRetries = manifest.retries ?? 1;
  let lastError;
  const attemptStartTimes = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const attemptStart = Date.now();
    try {
      const result = await runActor(actorName, envelope);
      // Add retry metadata to result
      result.attempts = attempt + 1;
      result.totalDurationMs = Date.now() - attemptStartTimes[0];
      return result;
    } catch (err) {
      lastError = err;
      attemptStartTimes.push(Date.now() - attemptStart);
      if (attempt < maxRetries) {
        // Exponential backoff with jitter
        const baseDelay = 1000 * Math.pow(2, attempt);
        const jitter = Math.random() * 500;
        await new Promise(r => setTimeout(r, baseDelay + jitter));
      }
    }
  }

  // All retries failed - emit error event with full context
  const errorBlob = await putBlob(JSON.stringify({
    message: lastError.message,
    attempts: maxRetries + 1,
    attemptDurations: attemptStartTimes,
    totalDurationMs: attemptStartTimes.reduce((a, b) => a + b, 0),
    rawOutput: lastError.rawOutput ? String(lastError.rawOutput).slice(0, 2000) : undefined,
    timestamp: new Date().toISOString()
  }, null, 2));

  await appendEvent({
    runId: envelope.runId,
    step: envelope.step,
    actor: actorName,
    eventType: `${actorName}-failed`,
    payloadRef: errorBlob,
    status: "error",
    parentStep: envelope.parentStep,
    metadata: {
      error: lastError.message,
      attempts: maxRetries + 1,
      totalDurationMs: attemptStartTimes.reduce((a, b) => a + b, 0)
    }
  });

  throw lastError;
}

/**
 * Streaming version for long outputs (optional)
 */
export async function runActorStreaming(actorName, envelope, onToken) {
  const manifest = await loadManifest(actorName);
  const modelInfo = await resolveModel(manifest.model);
  const endpoint = modelInfo.endpoint;
  const modelTag = modelInfo.modelTag;

  // Build context (same as non-streaming)
  let context = "";
  if (envelope.contextRefs && envelope.contextRefs.length > 0) {
    const contextParts = [];
    for (const ref of envelope.contextRefs) {
      const content = await getBlob(ref);
      if (content) contextParts.push(`[${ref}]\n${content}`);
    }
    context = contextParts.join("\n\n---\n\n");
  }

  const messages = buildMessages(manifest, context, envelope.payload);

  const body = {
    model: modelTag,
    messages,
    stream: true,
    think: manifest.think ?? modelInfo.think ?? false,
    options: {
      temperature: manifest.temperature ?? 0.2,
      top_p: manifest.topP ?? 0.9,
      num_predict: manifest.maxTokens ?? 2048,
    },
  };

  const response = await fetch(`${endpoint}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama ${response.status}: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let fullThinking = "";

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
        if (obj.message?.content) {
          fullContent += obj.message.content;
          onToken(obj.message.content);
        }
        if (obj.message?.thinking) {
          fullThinking += obj.message.thinking;
        }
        if (obj.done) {
          // Fall back to thinking for thinking models (content may be empty)
          let output = fullContent;
          if (!output.trim() && fullThinking.trim()) {
            const extracted = extractJson(fullThinking);
            output = extracted !== null ? JSON.stringify(extracted) : fullThinking;
          }
          // Validate and store final output
          let parsedOutput;
          try {
            parsedOutput = JSON.parse(output);
          } catch {
            parsedOutput = output;
          }
          const outputValidation = validateOutput(manifest, parsedOutput);
          if (!outputValidation.valid) {
            throw new Error(`Output validation failed: ${outputValidation.error}`);
          }
          const outputCid = await putBlob(typeof parsedOutput === "string" ? parsedOutput : JSON.stringify(parsedOutput, null, 2));
          for (const eventType of manifest.emits) {
            await appendEvent({
              runId: envelope.runId,
              step: envelope.step,
              actor: actorName,
              eventType,
              payloadRef: outputCid,
              status: "ok",
              parentStep: envelope.parentStep
            });
          }
          return { output: parsedOutput, outputCid };
        }
      } catch (e) {
        // Skip malformed lines
      }
    }
  }
}