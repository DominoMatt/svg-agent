import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 5173;
const OLLAMA_BASE = process.env.OLLAMA_BASE || "http://127.0.0.1:11434";
const STUDIO_BASE = process.env.STUDIO_BASE || "http://127.0.0.1:3000";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(__dirname, "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function proxy(target, req, res) {
  const url = new URL(req.url, target);
  const headers = { ...req.headers, host: url.host };
  delete headers["content-length"];

  const body = ["POST", "PUT", "PATCH"].includes(req.method)
    ? await new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      })
    : undefined;

  let upstream;
  try {
    upstream = await fetch(url.href, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    cors(res);
    res.writeHead(502, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "upstream_unreachable", target, detail: err.message }));
  }

  cors(res);
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "application/octet-stream",
  });

  if (upstream.body) {
    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    pump().catch(() => res.end());
  } else {
    res.end();
  }
}

async function serveStatic(req, res) {
  let filePath = join(PUBLIC, req.url === "/" ? "index.html" : req.url);
  filePath = filePath.split("?")[0];

  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (req.url === "/healthz") {
    cors(res);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ollama: OLLAMA_BASE, studio: STUDIO_BASE }));
  }

  // Proxy: /api/ollama/* -> Ollama
  if (req.url.startsWith("/api/ollama/")) {
    req.url = req.url.replace("/api/ollama", "");
    return proxy(OLLAMA_BASE, req, res);
  }

  // Proxy: /api/studio/* -> Studio (future)
  if (req.url.startsWith("/api/studio/")) {
    req.url = req.url.replace("/api/studio", "");
    return proxy(STUDIO_BASE, req, res);
  }

  // Default: proxy to Ollama for any /api/* (convenience alias)
  if (req.url.startsWith("/api/")) {
    return proxy(OLLAMA_BASE, req, res);
  }

  // Static files
  serveStatic(req, res);
});

// Prevent crashes from unhandled promise rejections
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err?.message || err);
});

server.listen(PORT, () => {
  console.log(`\n  llm-agent playground`);
  console.log(`  ───────────────────`);
  console.log(`  UI:      http://localhost:${PORT}`);
  console.log(`  Ollama:  ${OLLAMA_BASE}`);
  console.log(`  Studio:  ${STUDIO_BASE} (future)\n`);
});
