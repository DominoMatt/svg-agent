/**
 * manifest.mjs — Actor Manifest Loader & Validator
 *
 * Loads YAML from server/registry/*.yaml
 * Validates against JSON Schema (inputSchema/outputSchema)
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REGISTRY_DIR = join(__dirname, "registry");

const manifestCache = new Map();

export async function loadManifest(actorName) {
  if (manifestCache.has(actorName)) return manifestCache.get(actorName);

  const path = join(REGISTRY_DIR, `${actorName}.yaml`);
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new Error(`Manifest not found: ${actorName}`);
  }

  const manifest = parseYaml(content);
  validateManifest(manifest, actorName);
  manifestCache.set(actorName, manifest);
  return manifest;
}

export async function listManifests() {
  const files = await readdir(REGISTRY_DIR).catch(() => []);
  return files
    .filter(f => f.endsWith(".yaml") && f !== "routes.yaml")
    .map(f => f.replace(".yaml", ""));
}

function parseYaml(content) {
  // Minimal YAML parser for our subset (key: value, arrays, nested objects)
  // For production, could use 'js-yaml' but keeping zero-deps
  const lines = content.split("\n");
  const result = {};
  let currentKey = null;
  let currentArray = null;
  let indentStack = [{ obj: result, indent: -1 }];

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Handle array items
    if (trimmed.startsWith("- ")) {
      const value = trimmed.slice(2).trim();
      if (currentArray !== null) {
        currentArray.push(parseValue(value));
      }
      continue;
    }

    // Handle key: value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      // Pop indent stack
      while (indentStack.length > 1 && indentStack[indentStack.length - 1].indent >= indent) {
        indentStack.pop();
      }

      const parent = indentStack[indentStack.length - 1].obj;
      currentArray = null;

      if (value === "" || value === "|") {
        // Multi-line string or nested object - simplified handling
        parent[key] = value === "|" ? "" : {};
        if (value === "|") {
          // Next lines with higher indent are the string content
          // This is a simplification - real YAML is more complex
        } else if (typeof parent[key] === "object") {
          indentStack.push({ obj: parent[key], indent: indent });
        }
      } else {
        parent[key] = parseValue(value);
      }
      currentKey = key;
    } else if (indent > indentStack[indentStack.length - 1].indent && currentKey) {
      // Continuation of multi-line string
      const parent = indentStack[indentStack.length - 1].obj;
      if (typeof parent[currentKey] === "string") {
        parent[currentKey] += "\n" + trimmed;
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

function validateManifest(manifest, name) {
  const required = ["name", "model", "systemPrompt", "inputSchema", "outputSchema", "emits"];
  for (const field of required) {
    if (!manifest[field]) throw new Error(`Manifest ${name}: missing required field '${field}'`);
  }
  if (manifest.name !== name) throw new Error(`Manifest name mismatch: ${manifest.name} !== ${name}`);
}

export function validateInput(manifest, input) {
  return validateAgainstSchema(input, manifest.inputSchema);
}

export function validateOutput(manifest, output) {
  return validateAgainstSchema(output, manifest.outputSchema);
}

function validateAgainstSchema(data, schema) {
  // Minimal JSON Schema validation (type, required, properties, enum)
  if (schema.type === "object") {
    if (typeof data !== "object" || data === null) return { valid: false, error: "Expected object" };
    if (schema.required) {
      for (const req of schema.required) {
        if (!(req in data)) return { valid: false, error: `Missing required field: ${req}` };
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          const res = validateAgainstSchema(data[key], propSchema);
          if (!res.valid) return { valid: false, error: `${key}: ${res.error}` };
        }
      }
    }
    return { valid: true };
  }
  if (schema.type === "array") {
    if (!Array.isArray(data)) return { valid: false, error: "Expected array" };
    if (schema.items) {
      for (const item of data) {
        const res = validateAgainstSchema(item, schema.items);
        if (!res.valid) return { valid: false, error: `Array item: ${res.error}` };
      }
    }
    if (schema.minItems && data.length < schema.minItems) return { valid: false, error: `Min items: ${schema.minItems}` };
    if (schema.maxItems && data.length > schema.maxItems) return { valid: false, error: `Max items: ${schema.maxItems}` };
    return { valid: true };
  }
  if (schema.type === "string") {
    if (typeof data !== "string") return { valid: false, error: "Expected string" };
    if (schema.enum && !schema.enum.includes(data)) return { valid: false, error: `Enum mismatch: ${data}` };
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) return { valid: false, error: `Pattern mismatch` };
    return { valid: true };
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof data !== "number") return { valid: false, error: "Expected number" };
    return { valid: true };
  }
  if (schema.type === "boolean") {
    if (typeof data !== "boolean") return { valid: false, error: "Expected boolean" };
    return { valid: true };
  }
  return { valid: true };
}