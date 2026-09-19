// Static file server + TypeSafe proxy. The API key stays server-side (.env),
// the browser only ever talks to /api/decide.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 5173);
const API_KEY = process.env.TYPESAFE_API_KEY;
const API_URL = process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.TYPESAFE_MODEL || "jev-latest";
// TYPESAFE_TRACE=N saves the first N request/response pairs to .audit/trace/ (API key never written).
const TRACE_MAX = Number(process.env.TYPESAFE_TRACE || 0);
const TRACE_DIR = path.join(ROOT, ".audit/trace");
let traced = 0;

if (!API_KEY) {
  console.warn("[warn] TYPESAFE_API_KEY is not set — with no Jev answers the fly just waits on the pad.");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

// URL prefix -> directory on disk
const MOUNTS = [
  ["/vendor/three/", path.join(ROOT, "node_modules/three/")],
  ["/screenshots/", path.join(ROOT, "screenshots/")],
  ["/", path.join(ROOT, "public/")],
];

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    let file = path.join(dir, urlPath.slice(prefix.length));
    if (!file.startsWith(dir)) break; // path traversal
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) break;
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

let stats = { requests: 0, errors: 0, inputTokens: 0, firstRequestId: null, lastRequestId: null, lastAt: null };
const keyHint = API_KEY ? `…${API_KEY.slice(-4)}` : "none"; // enough to tell keys apart, not to leak one

// Periodic proof-of-use line: request ids come from TypeSafe's own response headers.
setInterval(() => {
  if (!stats.lastAt || Date.now() - stats.lastAt > 30_000) return;
  console.log(
    `[typesafe] key ${keyHint} · ${stats.requests} calls · ${stats.inputTokens.toLocaleString()} input tokens` +
      ` · ~$${((stats.inputTokens / 1e6) * 0.042).toFixed(3)} · last ${stats.lastRequestId}`,
  );
}, 30_000).unref();

async function handleDecide(req, res) {
  const started = performance.now();
  try {
    const body = JSON.parse(await readBody(req));
    if (!API_KEY) throw Object.assign(new Error("TYPESAFE_API_KEY missing"), { status: 500 });
    const payload = { model: MODEL, state: body.state, questions: body.questions };
    const upstream = await fetch(API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await upstream.text();
    const requestId = upstream.headers.get("x-typesafe-request-id");
    if (traced < TRACE_MAX) {
      traced++;
      let response;
      try { response = JSON.parse(text); } catch { response = text; }
      fs.mkdirSync(TRACE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(TRACE_DIR, `call-${String(traced).padStart(3, "0")}.json`),
        JSON.stringify({
          endpoint: API_URL,
          status: upstream.status,
          request_id: requestId,
          latency_ms: Math.round(performance.now() - started),
          request: payload,
          response,
        }, null, 2),
      );
    }
    stats.requests++;
    stats.lastAt = Date.now();
    if (requestId) {
      stats.firstRequestId ??= requestId;
      stats.lastRequestId = requestId;
    }
    if (!upstream.ok) {
      stats.errors++;
      res.writeHead(upstream.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: text.slice(0, 500), status: upstream.status }));
      return;
    }
    const data = JSON.parse(text);
    stats.inputTokens += data.usage?.input_tokens || 0;
    data.server_ms = Math.round(performance.now() - started);
    data.request_id = requestId;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err) {
    stats.errors++;
    res.writeHead(err.status || 502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/decide") return handleDecide(req, res);
  if (req.method === "GET" && req.url === "/api/stats") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ...stats, model: MODEL, hasKey: !!API_KEY, endpoint: API_URL }));
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Jev's Fly running at http://localhost:${PORT}  (model: ${MODEL}, key: ${keyHint}, endpoint: ${API_URL})`);
});
