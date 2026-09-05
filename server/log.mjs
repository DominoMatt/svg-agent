/**
 * log.mjs — Append-Only Event Log (JSONL)
 *
 * Each line: { runId, step, actor, eventType, payloadRef, status, timestamp, parentStep }
 * Query by runId for trace visualization
 */

import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const LOG_PATH = join(__dirname, "..", "data", "log.jsonl");

async function ensureLog() {
  await mkdir(join(__dirname, "..", "data"), { recursive: true });
  try {
    await readFile(LOG_PATH);
  } catch {
    await writeFile(LOG_PATH, "");
  }
}

export async function appendEvent(event) {
  await ensureLog();
  const line = JSON.stringify({
    ...event,
    timestamp: event.timestamp || Date.now()
  }) + "\n";
  await appendFile(LOG_PATH, line);
}

export async function getEventsByRunId(runId) {
  await ensureLog();
  const content = await readFile(LOG_PATH, "utf8");
  if (!content.trim()) return [];
  return content.trim().split("\n")
    .map(line => JSON.parse(line))
    .filter(e => e.runId === runId)
    .sort((a, b) => a.step - b.step);
}

export async function getLatestEvent(runId, eventType) {
  const events = await getEventsByRunId(runId);
  return events.reverse().find(e => e.eventType === eventType) || null;
}

export async function getAllEventsForStep(runId, step) {
  const events = await getEventsByRunId(runId);
  return events.filter(e => e.step === step);
}

export async function eventExists(runId, eventType) {
  const events = await getEventsByRunId(runId);
  return events.some(e => e.eventType === eventType);
}

/**
 * Check if all required event types exist for a runId (fan-in)
 */
export async function allEventsPresent(runId, eventTypes) {
  const events = await getEventsByRunId(runId);
  const present = new Set(events.map(e => e.eventType));
  return eventTypes.every(t => present.has(t));
}

export async function getRunTrace(runId) {
  const events = await getEventsByRunId(runId);
  // Build DAG: step -> { actor, eventType, status, children }
  // Use the LATEST event for each step to reflect current status
  const steps = {};
  for (const e of events) {
    // Always update with latest event for this step
    steps[e.step] = {
      step: e.step,
      actor: e.actor,
      eventType: e.eventType,
      status: e.status,
      payloadRef: e.payloadRef,
      metadata: e.metadata,
      children: []
    };
    if (e.parentStep !== undefined && steps[e.parentStep]) {
      steps[e.parentStep].children.push(e.step);
    }
  }
  return Object.values(steps).sort((a, b) => a.step - b.step);
}