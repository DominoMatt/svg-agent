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
  const response = await callOllama(endpoint, modelTag, messages, manifest);

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
    throw new Error(`Output validation failed for ${actorName}: ${outputValidation.error}`);
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

async function callOllama(endpoint, modelTag, messages, manifest) {
  const body = {
    model: modelTag,
    messages,
    stream: false,
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
    return data.message?.content || "";
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
        if (obj.done) {
          // Validate and store final output
          let parsedOutput;
          try {
            parsedOutput = JSON.parse(fullContent);
          } catch {
            parsedOutput = fullContent;
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