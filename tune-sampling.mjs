/**
 * tune-sampling.mjs — Incremental temp/top-p tuning for an actor.
 *
 * Calls the model DIRECTLY (no harness side-effects) with custom sampling
 * params, using the real manifest prompt + output validation, and reports
 * success rate per (temperature, topP) pairing.
 *
 * Usage:
 *   node tune-sampling.mjs --actor svg-planner --trials 3 \
 *     --goal "Create a simple SVG circle with radius 50" \
 *     --pairings "0.1:0.8,0.2:0.9,0.3:0.9,0.5:0.9,0.7:0.95,0.9:0.95"
 *
 * Only adopt a pairing into the manifest once it hits 100% consistently.
 */

import { loadManifest, validateOutput } from "./server/manifest.mjs";
import { resolveModel } from "./server/modelRegistry.mjs";
import { extractModelOutput } from "./actors/runner.mjs";

const OLLAMA_TIMEOUT_MS = 60000;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function parsePairings(str) {
  return str.split(",").map(p => {
    const [temperature, topP] = p.split(":").map(Number);
    return { temperature, topP };
  });
}

// Mirrors formatPayloadForPrompt in actors/runner.mjs
function formatPayload(payload, schema) {
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

async function callOnce(modelInfo, manifest, messages, p) {
  const body = {
    model: modelInfo.modelTag,
    messages,
    stream: false,
    think: manifest.think ?? modelInfo.think ?? false,
    options: {
      temperature: p.temperature,
      top_p: p.topP,
      num_predict: manifest.maxTokens ?? 2048,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const res = await fetch(`${modelInfo.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return extractModelOutput(data);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const actor = args.actor || "svg-planner";
  const trials = Number(args.trials) || 3;
  const goal = args.goal || "Create a simple SVG circle with radius 50";
  const pairings = parsePairings(
    args.pairings || "0.1:0.8,0.2:0.9,0.3:0.9,0.5:0.9,0.7:0.95,0.9:0.95"
  );

  const manifest = await loadManifest(actor);
  const modelInfo = await resolveModel(manifest.model);
  const payload = { userRequest: goal };
  const messages = [
    { role: "system", content: manifest.systemPrompt },
    { role: "user", content: formatPayload(payload, manifest.inputSchema) },
  ];

  console.log(`🎛  Tuning actor: ${actor} (model: ${modelInfo.modelTag})`);
  console.log(`   Goal: "${goal}"`);
  console.log(`   Trials per pairing: ${trials}\n`);

  const results = [];
  for (const p of pairings) {
    let ok = 0;
    const failures = [];
    for (let i = 0; i < trials; i++) {
      try {
        const output = await callOnce(modelInfo, manifest, messages, p);
        let parsed;
        try { parsed = JSON.parse(output); } catch { parsed = output; }
        const v = validateOutput(manifest, parsed);
        if (v.valid) ok++;
        else failures.push(v.error);
      } catch (err) {
        failures.push(`ERR: ${err.message}`);
      }
    }
    const pct = (ok / trials) * 100;
    results.push({ ...p, ok, trials, pct, failures });
    const flag = pct === 100 ? "✅" : pct >= 60 ? "⚠️" : "❌";
    console.log(`${flag} temp=${p.temperature} topP=${p.topP}: ${ok}/${trials} (${pct.toFixed(0)}%)`);
    if (failures.length) {
      const uniq = [...new Set(failures)].slice(0, 3);
      console.log(`     failures: ${uniq.join(" | ")}`);
    }
  }

  console.log("\n📊 Summary (sorted by success rate):");
  results
    .sort((a, b) => b.pct - a.pct || a.temperature - b.temperature)
    .forEach(r => console.log(`   temp=${r.temperature} topP=${r.topP}: ${r.pct.toFixed(0)}%`));
}

main().catch(err => {
  console.error("Tuning failed:", err);
  process.exit(1);
});