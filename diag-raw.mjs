/**
 * diag-raw.mjs — print the raw Ollama response (content + thinking) for an actor.
 * Useful for diagnosing format-adherence failures.
 *
 * Usage:
 *   node diag-raw.mjs [actor] [goal] [temperature] [topP]
 *   node diag-raw.mjs svg-planner "Create a simple SVG circle with radius 50" 0.1 0.8
 */

import { loadManifest } from "./server/manifest.mjs";
import { resolveModel } from "./server/modelRegistry.mjs";
import { extractModelOutput } from "./actors/runner.mjs";

const actor = process.argv[2] || "svg-planner";
const goal = process.argv[3] || "Create a simple SVG circle with radius 50";
const temp = Number(process.argv[4] || 0.1);
const topP = Number(process.argv[5] || 0.8);

const manifest = await loadManifest(actor);
const modelInfo = await resolveModel(manifest.model);
const messages = [
  { role: "system", content: manifest.systemPrompt },
  { role: "user", content: `userRequest (The high-level goal from the user): "${goal}"` },
];
const body = {
  model: modelInfo.modelTag,
  messages,
  stream: false,
  think: manifest.think ?? modelInfo.think ?? false,
  options: { temperature: temp, top_p: topP, num_predict: manifest.maxTokens ?? 2048 },
};

const res = await fetch(`${modelInfo.endpoint}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json();

console.log(`=== actor=${actor} think=${body.think} temp=${temp} topP=${topP} ===`);
console.log("CONTENT:", JSON.stringify(data?.message?.content ?? ""));
console.log("THINKING:", JSON.stringify(data?.message?.thinking ?? "").slice(0, 1000));
console.log("EXTRACTED:", JSON.stringify(extractModelOutput(data)).slice(0, 700));