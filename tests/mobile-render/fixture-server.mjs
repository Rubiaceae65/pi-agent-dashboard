/**
 * fixture-server.mjs — a REAL server for the phone-client render test.
 *
 * It serves the repo's own `public/mobile/` files over HTTP and answers
 * `/api/sessions` and `/ws` from PAYLOADS RECORDED OFF THE LIVE DASHBOARD
 * (tests/mobile-render/fixtures/, captured 2026-09-30 — see README.md there
 * and artifacts/fixtures/ for the full uncropped captures).
 *
 * It is a real WebSocket, not a stub: the test drives the page exactly as a
 * phone would, and the only thing replaced is where the bytes come from. A
 * test that stubbed `WebSocket` in the page would pass while the transport
 * contract (`/api/ws-ticket` → `/ws?ticket=`) rotted.
 *
 * Prints `PORT <n>` on stdout once listening.
 */
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const MOBILE = join(REPO, "public", "mobile");
const FIX = join(HERE, "fixtures");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
};

// sessionId -> recorded events
const streams = new Map();
for (const f of readdirSync(FIX).filter((f) => f.endsWith(".jsonl"))) {
  const events = [];
  let id = "";
  for (const line of readFileSync(join(FIX, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    id = m.sessionId || id; // the server stamped it; the filename is a claim
    for (const e of m.events || []) events.push(e);
  }
  events.sort((a, b) => a.seq - b.seq);
  // Merged across files, then re-sorted: `seq` is monotonic per session and
  // the client DROPS anything at or below its resume cursor, so a fixture that
  // arrives out of order silently loses events.
  if (id) streams.set(id, (streams.get(id) || []).concat(events).sort((a, b) => a.seq - b.seq));
}

const sessionsBody = readFileSync(join(FIX, "sessions.json"), "utf8");

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/sessions") {
    res.writeHead(200, { "content-type": MIME[".json"] });
    return res.end(sessionsBody);
  }
  if (url.pathname === "/api/ws-ticket" && req.method === "POST") {
    res.writeHead(200, { "content-type": MIME[".json"] });
    return res.end(JSON.stringify({ success: true, data: { ticket: "fixture-ticket" } }));
  }
  if (url.pathname.startsWith("/mobile/")) {
    const rel = url.pathname.slice("/mobile/".length) || "index.html";
    const abs = join(MOBILE, normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (abs.startsWith(MOBILE) && existsSync(abs)) {
      const ext = abs.slice(abs.lastIndexOf("."));
      res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
      return res.end(readFileSync(abs));
    }
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found: " + url.pathname);
});

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type !== "subscribe") return;
    const events = streams.get(msg.sessionId);
    if (!events) return;
    const from = Number.isFinite(msg.lastSeq) ? msg.lastSeq : 0;
    for (const e of events) {
      if (e.seq <= from) continue;
      ws.send(JSON.stringify({ type: "event", sessionId: msg.sessionId, seq: e.seq, event: e.event }));
    }
    ws.send(JSON.stringify({ type: "event_replay", sessionId: msg.sessionId, events, isLast: true }));
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(`PORT ${server.address().port}`);
});
