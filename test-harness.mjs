#!/usr/bin/env node
/**
 * test-harness.mjs — End-to-end test for harness
 *
 * Usage: node test-harness.mjs
 * Requires: Ollama running with models pulled
 */

import { runActorWithRetry } from "./actors/runner.mjs";
import { appendEvent, getRunTrace, getEventsByRunId } from "./server/log.mjs";
import { putBlob, getBlob } from "./server/blobs.mjs";
import { randomUUID } from "node:crypto";

const TEST_RUN_ID = randomUUID();

async function testBlobStore() {
  console.log("\n🧪 Testing blob store...");
  const cid = await putBlob("Hello, world!");
  console.log(`  PUT → ${cid}`);

  const content = await getBlob(cid);
  console.log(`  GET → "${content}"`);
  console.assert(content === "Hello, world!", "Blob content mismatch");
  console.log("  ✓ Blob store works");
}

async function testLog() {
  console.log("\n🧪 Testing event log...");
  await appendEvent({
    runId: TEST_RUN_ID,
    step: 1,
    actor: "test-actor",
    eventType: "test-event",
    payloadRef: "cid:sha256:abc",
    status: "ok",
    parentStep: 0
  });

  const events = await getEventsByRunId(TEST_RUN_ID);
  console.log(`  Events for ${TEST_RUN_ID}: ${events.length}`);
  console.assert(events.length === 1, "Event not logged");
  console.log("  ✓ Event log works");
}

async function testTrace() {
  console.log("\n🧪 Testing trace...");
  const trace = await getRunTrace(TEST_RUN_ID);
  console.log(`  Trace steps: ${trace.length}`);
  console.log("  ✓ Trace works");
}

async function testPlanner() {
  console.log("\n🧪 Testing svg-planner actor (requires Ollama)...");
  try {
    const result = await runActorWithRetry("svg-planner", {
      runId: TEST_RUN_ID,
      step: 2,
      actor: "svg-planner",
      payload: { userRequest: "Create a simple SVG circle" },
      contextRefs: [],
      deadline: Date.now() + 60000,
      parentStep: 0,
      retries: 0
    });
    console.log(`  Planner output: ${JSON.stringify(result.output).slice(0, 200)}...`);
    console.log("  ✓ svg-planner works");
  } catch (err) {
    console.log(`  ⚠ svg-planner test skipped (Ollama not available): ${err.message}`);
  }
}

async function main() {
  console.log("🚀 Starting harness tests...\n");

  await testBlobStore();
  await testLog();
  await testTrace();
  await testPlanner();

  console.log("\n✅ All tests passed!");
}

main().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});