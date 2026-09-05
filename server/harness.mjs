/**
 * harness.mjs — Queue + Scheduler + API
 *
 * - Enqueue envelopes
 * - Scheduler: reads log, matches routing rules, enqueues next actors
 * - HTTP API for UI integration
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runActorWithRetry } from "../actors/runner.mjs";
import { appendEvent, getEventsByRunId, getRunTrace, allEventsPresent } from "./log.mjs";
import { listManifests } from "./manifest.mjs";
import { loadModelRegistry } from "./modelRegistry.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.HARNESS_PORT) || 5174;

const ROUTES_PATH = join(__dirname, "registry", "routes.yaml");
const QUEUE_PATH = join(__dirname, "..", "data", "queue.jsonl");
const DEAD_LETTER_PATH = join(__dirname, "..", "data", "dead-letter.jsonl");
let routingRules = [];

// Persistent queue (survives restart)
const queue = [];
let processing = false;

// WebSocket clients for live updates
const wsClients = new Set();

// Metrics
const metrics = {
  totalRuns: 0,
  totalSteps: 0,
  totalErrors: 0,
  actorDurations: {},
  startTime: Date.now()
};

// Load persisted queue on startup
async function loadPersistedQueue() {
  try {
    const content = await readFile(QUEUE_PATH, "utf8");
    if (content.trim()) {
      const lines = content.trim().split("\n");
      for (const line of lines) {
        try {
          const envelope = JSON.parse(line);
          // Only re-queue pending/running items, not completed
          if (envelope.status === "pending" || envelope.status === "running") {
            queue.push(envelope);
          }
        } catch {}
      }
      console.log(`[Harness] Loaded ${queue.length} items from persisted queue`);
    }
  } catch {
    // Queue file doesn't exist yet
  }
}

// Persist queue to disk
async function persistQueue() {
  try {
    await mkdir(join(__dirname, "..", "data"), { recursive: true });
    const lines = queue.map(e => JSON.stringify(e)).join("\n");
    await writeFile(QUEUE_PATH, lines + (lines ? "\n" : ""));
  } catch (err) {
    console.error("[Harness] Failed to persist queue:", err.message);
  }
}

// Add to dead letter queue
async function addToDeadLetter(envelope, error) {
  try {
    await mkdir(join(__dirname, "..", "data"), { recursive: true });
    const entry = {
      ...envelope,
      error: error.message,
      timestamp: Date.now(),
      attempts: envelope.retries + 1
    };
    await writeFile(DEAD_LETTER_PATH, JSON.stringify(entry) + "\n", { flag: "a" });
  } catch (err) {
    console.error("[Harness] Failed to write dead letter:", err.message);
  }
}

// Broadcast to WebSocket clients
function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wsClients) {
    try {
      client.send(data);
    } catch {
      wsClients.delete(client);
    }
  }
}

async function loadRoutingRules() {
  try {
    const content = await readFile(ROUTES_PATH, "utf8");
    routingRules = parseRoutesYaml(content);
  } catch {
    routingRules = [];
  }
}

function parseRoutesYaml(content) {
  // Minimal parser for routes.yaml
  const rules = [];
  const lines = content.split("\n");
  let currentRule = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (trimmed.startsWith("- when:")) {
      if (currentRule) rules.push(currentRule);
      currentRule = { when: [], then: [], maxRetries: 3, backoff: "exponential" };
      const whenVal = trimmed.slice(7).trim();
      if (whenVal.startsWith("[")) {
        currentRule.when = whenVal.slice(1, -1).split(",").map(s => s.trim());
      } else {
        currentRule.when = [whenVal];
      }
    } else if (trimmed.startsWith("then:")) {
      const thenVal = trimmed.slice(5).trim();
      if (thenVal.startsWith("[")) {
        currentRule.then = thenVal.slice(1, -1).split(",").map(s => s.trim());
      } else {
        currentRule.then = [thenVal];
      }
    } else if (trimmed.startsWith("maxRetries:")) {
      currentRule.maxRetries = parseInt(trimmed.slice(11), 10);
    } else if (trimmed.startsWith("backoff:")) {
      currentRule.backoff = trimmed.slice(8).trim();
    } else if (trimmed.startsWith("injectContext:")) {
      currentRule.injectContext = trimmed.slice(14).trim();
    }
  }
  if (currentRule) rules.push(currentRule);
  return rules;
}

async function enqueue(envelope) {
  // Add status for persistence
  const envelopeWithStatus = { ...envelope, status: "pending", enqueuedAt: Date.now() };
  queue.push(envelopeWithStatus);
  await persistQueue();

  await appendEvent({
    runId: envelope.runId,
    step: envelope.step,
    actor: envelope.actor,
    eventType: "enqueued",
    payloadRef: "",
    status: "pending",
    parentStep: envelope.parentStep
  });

  // Track new runs
  if (envelope.step === 1 && envelope.parentStep === 0) {
    metrics.totalRuns++;
  }

  broadcast({ type: "enqueued", runId: envelope.runId, step: envelope.step, actor: envelope.actor });
  processQueue();
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;

  while (queue.length > 0) {
    const envelope = queue.shift();
    envelope.status = "running";
    envelope.startedAt = Date.now();
    await persistQueue();

    const stepStart = Date.now();
    console.log(`[${envelope.runId.slice(0,8)}] Step ${envelope.step}: ${envelope.actor} (queue: ${queue.length})`);

    broadcast({ type: "started", runId: envelope.runId, step: envelope.step, actor: envelope.actor });

    try {
      const result = await runActorWithRetry(envelope.actor, envelope);
      const duration = Date.now() - stepStart;

      // Update metrics
      metrics.totalSteps++;
      metrics.actorDurations[envelope.actor] = metrics.actorDurations[envelope.actor] || [];
      metrics.actorDurations[envelope.actor].push(duration);

      console.log(`[${envelope.runId.slice(0,8)}] ✓ ${envelope.actor} completed in ${duration}ms (attempt ${result.attempts || 1})`);

      broadcast({ type: "completed", runId: envelope.runId, step: envelope.step, actor: envelope.actor, duration, result });

      // After successful run, check routing rules
      await checkRoutingRules(envelope, result.eventTypes || []);
    } catch (err) {
      const duration = Date.now() - stepStart;
      metrics.totalErrors++;
      console.error(`[${envelope.runId.slice(0,8)}] ✗ ${envelope.actor} failed after ${duration}ms:`, err.message);

      broadcast({ type: "failed", runId: envelope.runId, step: envelope.step, actor: envelope.actor, duration, error: err.message });

      // Add to dead letter queue after all retries exhausted
      await addToDeadLetter(envelope, err);
      // Error event already emitted by runner
    }

    await persistQueue();
  }

  processing = false;
  broadcast({ type: "queue-empty" });
}

async function checkRoutingRules(completedEnvelope, emittedEventTypes = []) {
  const runId = completedEnvelope.runId;

  for (const rule of routingRules) {
    const whenTypes = Array.isArray(rule.when) ? rule.when : [rule.when];
    // Match on the event types the actor actually emitted (manifest.emits),
    // NOT the actor name — routes.yaml rules are keyed on event types
    // (e.g. `plan-created`, not `svg-planner`).
    const triggered = whenTypes.some(t => emittedEventTypes.includes(t));

    if (!triggered) continue;

    // For fan-in: check if all required events are present
    if (whenTypes.length > 1) {
      const allPresent = await allEventsPresent(runId, whenTypes);
      if (!allPresent) continue;
    }

    // Enqueue next actors
    for (const nextActor of rule.then) {
      const nextStep = completedEnvelope.step + 1;
      // Dedup: don't enqueue the same actor for the same parent step twice
      // (e.g. a fan-in rule fires once per completing branch).
      if (await alreadyEnqueued(runId, nextActor, completedEnvelope.step)) continue;

      // Only enqueue if the plan has a step for this actor
      if (!(await planHasStep(runId, nextActor))) {
        console.log(`[${runId.slice(0,8)}] Skipping ${nextActor} — no step in plan`);
        continue;
      }

      const payload = await buildPayloadForActor(runId, nextActor, rule);
      const contextRefs = await buildContextRefs(runId, rule);

      await enqueue({
        runId,
        step: nextStep,
        actor: nextActor,
        payload,
        contextRefs,
        deadline: Date.now() + 60000,
        parentStep: completedEnvelope.step,
        retries: 0
      });
    }
  }
}

// True if an envelope for (runId, actor, parentStep) was already enqueued
async function alreadyEnqueued(runId, actor, parentStep) {
  const events = await getEventsByRunId(runId);
  return events.some(e => e.eventType === "enqueued" && e.actor === actor && e.parentStep === parentStep);
}

// True if the plan for this run has a step for the given actor
async function planHasStep(runId, actorName) {
  const events = await getEventsByRunId(runId);
  const planEvent = events.reverse().find(e => e.eventType === "plan-created");
  if (!planEvent || !planEvent.payloadRef) return false;
  const { getBlob } = await import("./blobs.mjs");
  const content = await getBlob(planEvent.payloadRef);
  if (!content) return false;
  try {
    const plan = JSON.parse(content);
    return plan.steps?.some(s => s.actor === actorName) ?? false;
  } catch {
    return false;
  }
}

async function buildPayloadForActor(runId, actorName, rule) {
  // Get the latest relevant event payloads
  const events = await getEventsByRunId(runId);
  const { getBlob } = await import("./blobs.mjs");

  // If a plan exists, extract the step input for the target actor.
  // The svg-planner emits { steps: [{actor, input}], context } — downstream
  // actors expect their own input schema (e.g. svg-coder needs {spec}).
  const planEvent = events.reverse().find(e => e.eventType === "plan-created");
  if (planEvent && planEvent.payloadRef) {
    const content = await getBlob(planEvent.payloadRef);
    if (content) {
      try {
        const plan = JSON.parse(content);
        if (plan && Array.isArray(plan.steps)) {
          const step = plan.steps.find(s => s.actor === actorName);
          if (step && step.input) return step.input;
        }
        return plan;
      } catch {
        return { raw: content };
      }
    }
  }

  // Fallback: latest event with a payloadRef
  const latest = events.reverse().find(e => e.payloadRef);
  if (latest && latest.payloadRef) {
    const content = await getBlob(latest.payloadRef);
    if (content) {
      try {
        return JSON.parse(content);
      } catch {
        return { raw: content };
      }
    }
  }
  return {};
}

async function buildContextRefs(runId, rule) {
  const refs = [];
  if (rule.injectContext) {
    const events = await getEventsByRunId(runId);
    const match = events.reverse().find(e => e.eventType === rule.injectContext);
    if (match && match.payloadRef) refs.push(match.payloadRef);
  }
  return refs;
}

// HTTP API
async function handleRequest(req, res) {
  const cors = (res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  cors(res);

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // POST /api/harness/start - Start new run
  if (req.method === "POST" && url.pathname === "/api/harness/start") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { goal } = JSON.parse(body);
        const runId = randomUUID();

        // Enqueue svg-planner as first step
        await enqueue({
          runId,
          step: 1,
          actor: "svg-planner",
          payload: { userRequest: goal },
          contextRefs: [],
          deadline: Date.now() + 60000,
          parentStep: 0,
          retries: 0
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ runId, status: "started" }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // POST /api/harness/enqueue - Manual enqueue
  if (req.method === "POST" && url.pathname === "/api/harness/enqueue") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const envelope = JSON.parse(body);
        await enqueue(envelope);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "enqueued" }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET /api/harness/trace/:runId
  if (req.method === "GET" && url.pathname.startsWith("/api/harness/trace/")) {
    const runId = url.pathname.split("/").pop();
    try {
      const trace = await getRunTrace(runId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runId, trace }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/harness/log/:runId
  if (req.method === "GET" && url.pathname.startsWith("/api/harness/log/")) {
    const runId = url.pathname.split("/").pop();
    try {
      const events = await getEventsByRunId(runId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runId, events }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/harness/actors - List available actors
  if (req.method === "GET" && url.pathname === "/api/harness/actors") {
    try {
      const actors = await listManifests();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ actors }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/harness/models - List models
  if (req.method === "GET" && url.pathname === "/api/harness/models") {
    try {
      const registry = await loadModelRegistry();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: registry.models }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/harness/replay/:runId/:step
  if (req.method === "POST" && url.pathname.startsWith("/api/harness/replay/")) {
    const parts = url.pathname.split("/");
    const runId = parts[parts.length - 2];
    const step = parseInt(parts[parts.length - 1], 10);
    try {
      const events = await getEventsByRunId(runId);
      const stepEvents = events.filter(e => e.step === step);
      for (const evt of stepEvents) {
        if (evt.status === "ok" || evt.status === "error") {
          await enqueue({
            runId,
            step: evt.step,
            actor: evt.actor,
            payload: {}, // Will be rebuilt from context
            contextRefs: [evt.payloadRef].filter(Boolean),
            deadline: Date.now() + 60000,
            parentStep: evt.parentStep,
            retries: 0
          });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "replaying", runId, step }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/harness/metrics - System metrics
  if (req.method === "GET" && url.pathname === "/api/harness/metrics") {
    const avgDurations = {};
    for (const [actor, durations] of Object.entries(metrics.actorDurations)) {
      avgDurations[actor] = durations.reduce((a, b) => a + b, 0) / durations.length;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      uptimeMs: Date.now() - metrics.startTime,
      totalRuns: metrics.totalRuns,
      totalSteps: metrics.totalSteps,
      totalErrors: metrics.totalErrors,
      queueLength: queue.length,
      avgActorDurationMs: avgDurations,
      actorCallCounts: Object.fromEntries(
        Object.entries(metrics.actorDurations).map(([k, v]) => [k, v.length])
      )
    }));
    return;
  }

  // GET /api/harness/health - Health check
  if (req.method === "GET" && url.pathname === "/api/harness/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptimeMs: Date.now() - metrics.startTime,
      queueLength: queue.length,
      processing
    }));
    return;
  }

  // GET /api/harness/blob/:cid - Retrieve blob content
  if (req.method === "GET" && url.pathname.startsWith("/api/harness/blob/")) {
    const cid = url.pathname.split("/").pop();
    try {
      const { getBlob } = await import("./blobs.mjs");
      const content = await getBlob(cid);
      if (content === null) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Blob not found" }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cid, content }));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/harness/runs - List all runs (from log)
  if (req.method === "GET" && url.pathname === "/api/harness/runs") {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const LOG_PATH = join(__dirname, "..", "data", "log.jsonl");
      const content = await readFile(LOG_PATH, "utf8").catch(() => "");
      const runs = new Map();

      for (const line of content.trim().split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (!runs.has(event.runId)) {
            runs.set(event.runId, {
              runId: event.runId,
              firstEvent: event.timestamp,
              lastEvent: event.timestamp,
              steps: new Set(),
              actors: new Set(),
              status: "running"
            });
          }
          const run = runs.get(event.runId);
          run.lastEvent = event.timestamp;
          run.steps.add(event.step);
          run.actors.add(event.actor);
          if (event.status === "error") run.status = "error";
          else if (event.eventType === "enqueued" && run.status !== "error") run.status = "pending";
          else if (event.status === "ok" && run.status !== "error") run.status = "completed";
        } catch {}
      }

      const runList = Array.from(runs.values())
        .map(r => ({
          runId: r.runId,
          startedAt: r.firstEvent,
          updatedAt: r.lastEvent,
          stepCount: r.steps.size,
          actors: Array.from(r.actors),
          status: r.status
        }))
        .sort((a, b) => b.startedAt - a.startedAt);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runs: runList }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/harness/dead-letter - List dead letter queue
  if (req.method === "GET" && url.pathname === "/api/harness/dead-letter") {
    try {
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(DEAD_LETTER_PATH, "utf8").catch(() => "");
      const entries = content.trim().split("\n")
        .filter(l => l.trim())
        .map(l => JSON.parse(l))
        .sort((a, b) => b.timestamp - a.timestamp);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ deadLetters: entries }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/harness/dead-letter/retry - Retry a dead letter
  if (req.method === "POST" && url.pathname === "/api/harness/dead-letter/retry") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { runId, step, actor } = JSON.parse(body);
        const events = await getEventsByRunId(runId);
        const stepEvents = events.filter(e => e.step === step && e.actor === actor);
        for (const evt of stepEvents) {
          await enqueue({
            runId,
            step: evt.step,
            actor: evt.actor,
            payload: {},
            contextRefs: [evt.payloadRef].filter(Boolean),
            deadline: Date.now() + 60000,
            parentStep: evt.parentStep,
            retries: 0
          });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "retrying", runId, step }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // GET /api/harness/export/:runId - Export run as JSON
  if (req.method === "GET" && url.pathname.startsWith("/api/harness/export/")) {
    const runId = url.pathname.split("/").pop();
    try {
      const events = await getEventsByRunId(runId);
      const trace = await getRunTrace(runId);
      const { getBlob } = await import("./blobs.mjs");

      // Fetch all blob contents
      const blobs = {};
      for (const evt of events) {
        if (evt.payloadRef && !blobs[evt.payloadRef]) {
          blobs[evt.payloadRef] = await getBlob(evt.payloadRef);
        }
      }

      const exportData = {
        runId,
        exportedAt: Date.now(),
        events,
        trace,
        blobs
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(exportData, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/harness/import - Import run
  if (req.method === "POST" && url.pathname === "/api/harness/import") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const importData = JSON.parse(body);
        const { putBlob } = await import("./blobs.mjs");

        // Restore blobs
        if (importData.blobs) {
          for (const [cid, content] of Object.entries(importData.blobs)) {
            if (content) await putBlob(content);
          }
        }

        // Restore events to log
        if (importData.events) {
          for (const evt of importData.events) {
            await appendEvent(evt);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "imported", runId: importData.runId }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

const server = createServer(handleRequest);

// WebSocket upgrade handling
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/api/harness/ws") {
    handleWebSocketUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

function handleWebSocketUpgrade(req, socket, head) {
  // Simple WebSocket handshake (no external deps)
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const crypto = require("node:crypto");
  const acceptKey = crypto.createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
    "\r\n"
  );

  // Simple frame parser
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = buffer[0] & 0x80;
      const opcode = buffer[0] & 0x0f;
      const masked = buffer[1] & 0x80;
      const payloadLen = buffer[1] & 0x7f;

      let offset = 2;
      let length = payloadLen;
      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        length = buffer.readBigUInt64BE(2);
        offset = 10;
      }

      if (masked) {
        if (buffer.length < offset + 4) return;
        const mask = buffer.subarray(offset, offset + 4);
        offset += 4;
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        for (let i = 0; i < length; i++) {
          payload[i] ^= mask[i % 4];
        }
        buffer = buffer.subarray(offset + length);
        handleWebSocketMessage(payload.toString());
      } else {
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        handleWebSocketMessage(payload.toString());
      }
    }
  });

  socket.on("close", () => {
    wsClients.delete(socket);
  });

  wsClients.add(socket);
  console.log(`[Harness] WebSocket client connected (total: ${wsClients.size})`);

  // Send initial state
  socket.send = (data) => {
    const payload = Buffer.from(data);
    const frame = Buffer.alloc(2 + payload.length);
    frame[0] = 0x81; // FIN + text frame
    frame[1] = payload.length;
    payload.copy(frame, 2);
    socket.write(frame);
  };

  socket.send(JSON.stringify({ type: "connected", queueLength: queue.length }));
}

function handleWebSocketMessage(message) {
  try {
    const msg = JSON.parse(message);
    if (msg.type === "ping") {
      // Respond with pong
      for (const client of wsClients) {
        client.send(JSON.stringify({ type: "pong" }));
      }
    }
  } catch {}
}

async function start() {
  await loadRoutingRules();
  await loadPersistedQueue();
  const actors = await listManifests();
  const registry = await loadModelRegistry();

  server.listen(PORT, () => {
    console.log(`\n  Harness API`);
    console.log(`  ────────────`);
    console.log(`  Port:     ${PORT}`);
    console.log(`  Actors:   ${actors.join(", ")}`);
    console.log(`  Models:   ${Object.keys(registry.models).join(", ")}`);
    console.log(`  WS:       ws://localhost:${PORT}/api/harness/ws`);
    console.log(`\n`);
  });
}

start().catch(err => {
  console.error("Failed to start harness:", err);
  process.exit(1);
});