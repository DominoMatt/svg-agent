/**
 * modelRegistry.mjs — Model Registry Loader
 *
 * Loads registry/models.yaml, resolves logical names to endpoints/tags
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REGISTRY_PATH = join(__dirname, "..", "registry", "models.yaml");

let registryCache = null;

export async function loadModelRegistry() {
  if (registryCache) return registryCache;
  const content = await readFile(REGISTRY_PATH, "utf8");
  registryCache = parseYaml(content);
  return registryCache;
}

export async function resolveModel(logicalName) {
  const registry = await loadModelRegistry();
  const model = registry.models[logicalName] || registry.models[registry.models.default];
  if (!model) throw new Error(`Model not found: ${logicalName}`);
  return model;
}

export async function getModelEndpoint(logicalName) {
  const model = await resolveModel(logicalName);
  return model.endpoint;
}

export async function getModelTag(logicalName) {
  const model = await resolveModel(logicalName);
  return model.modelTag;
}

export async function getModelContextWindow(logicalName) {
  const model = await resolveModel(logicalName);
  return model.contextWindow || 4096;
}

function parseYaml(content) {
  // Same minimal parser as manifest.mjs
  const lines = content.split("\n");
  const result = { models: {} };
  let currentModel = null;
  let indentStack = [{ obj: result, indent: -1 }];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    if (trimmed.startsWith("- ")) {
      const value = trimmed.slice(2).trim();
      // Arrays not used in models.yaml currently
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      while (indentStack.length > 1 && indentStack[indentStack.length - 1].indent >= indent) {
        indentStack.pop();
      }

      const parent = indentStack[indentStack.length - 1].obj;

      if (value === "") {
        parent[key] = {};
        indentStack.push({ obj: parent[key], indent: indent });
        if (key !== "models" && indentStack.length === 2) {
          currentModel = key;
        }
      } else {
        parent[key] = parseValue(value);
      }
    }
  }

  return result;
}

function parseValue(v) {
  v = v.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  if (/^\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  // Handle inline arrays: [item1, item2, ...]
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map(s => parseValue(s.trim()));
  }
  return v;
}