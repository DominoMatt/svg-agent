/**
 * blobs.mjs — Content-Addressable Blob Store
 *
 * PUT(content) → CID (sha256 hex)
 * GET(cid) → content
 * Uses file-based storage in data/blobs/
 */

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BLOBS_DIR = join(__dirname, "..", "data", "blobs");

async function ensureDir() {
  await mkdir(BLOBS_DIR, { recursive: true });
}

function cidOf(content) {
  return createHash("sha256").update(content).digest("hex");
}

function cidPath(cid) {
  // Shard by first 2 chars to avoid too many files in one dir
  const shard = cid.slice(0, 2);
  return join(BLOBS_DIR, shard, cid);
}

export async function putBlob(content) {
  await ensureDir();
  const cid = cidOf(content);
  const path = cidPath(cid);
  await mkdir(join(BLOBS_DIR, cid.slice(0, 2)), { recursive: true });
  await writeFile(path, content);
  return `cid:sha256:${cid}`;
}

export async function getBlob(cidRef) {
  // Accept "cid:sha256:abc" or just "abc"
  const cid = cidRef.replace(/^cid:sha256:/, "");
  const path = cidPath(cid);
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export async function hasBlob(cidRef) {
  const cid = cidRef.replace(/^cid:sha256:/, "");
  const path = cidPath(cid);
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compaction: summarize old blobs to save context budget
 * Returns new CID of summary, or null if not compacted
 */
export async function compactBlob(cidRef, maxTokens, summarizerModel) {
  const content = await getBlob(cidRef);
  if (!content) return null;

  // Rough token estimate: 1 token ≈ 4 chars
  const estimatedTokens = Math.ceil(content.length / 4);
  if (estimatedTokens <= maxTokens) return cidRef; // already fits

  // TODO: Call summarizer actor/model to produce summary
  // For now, just truncate (placeholder)
  const truncated = content.slice(0, maxTokens * 4);
  return putBlob(`[SUMMARIZED]\n${truncated}`);
}

export async function listBlobs() {
  // Debug helper
  const { readdir } = await import("node:fs/promises");
  const shards = await readdir(BLOBS_DIR).catch(() => []);
  const cids = [];
  for (const shard of shards) {
    const files = await readdir(join(BLOBS_DIR, shard)).catch(() => []);
    cids.push(...files.map(f => `cid:sha256:${f}`));
  }
  return cids;
}