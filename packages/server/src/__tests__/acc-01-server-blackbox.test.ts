/**
 * ACCEPTANCE CHECK A+B1/B2/B8/B9/B10 — black-box, against a REAL server over
 * REAL HTTP and a REAL WebSocket. No imports from the branch's internals: if the
 * wiring is removed but the module still works, this still fails.
 *
 * Run:  npx vitest run --project @blackbelt-technology/pi-dashboard-server \
 *         <this file>
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server.js";
import { LEAD, CHILD_A, CHILD_B, GRANDCHILD, buildTree, makeChild } from "./fixture.mjs";

let home, agentDir, base, server, wsUrl;

async function boot(extra = {}) {
  home = mkdtempSync(join(tmpdir(), "acc-subagents-"));
  const t = buildTree(home, extra);
  agentDir = t.agentDir;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  server = await createServer({ port: 0, piPort: 0, host: "127.0.0.1", dev: true,
    autoShutdown: false, shutdownIdleSeconds: 999, tunnel: false });
  await server.start();
  base = `http://127.0.0.1:${server.httpPort()}`;
  wsUrl = `ws://127.0.0.1:${server.httpPort()}/ws`;
  return server;
}

async function shutdown() { try { await server?.stop?.(); } catch {} try { rmSync(home, { recursive: true, force: true }); } catch {} }

/** Read the FIRST `sessions_snapshot` frame off a real websocket. */
function firstSnapshot(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("no sessions_snapshot within " + timeoutMs + "ms")); }, timeoutMs);
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type === "sessions_snapshot") { clearTimeout(t); ws.close(); resolve(msg); }
    };
    ws.onerror = (e) => { clearTimeout(t); reject(new Error("ws error: " + (e?.message ?? e))); };
  });
}

describe("ACCEPTANCE: rlm children reach the dashboard", () => {
  beforeAll(async () => { await boot(); });
  afterAll(async () => { await shutdown(); });

  it("A1/B1: GET /api/sessions returns each child with its parent", async () => {
    const r = await fetch(`${base}/api/sessions`);
    expect(r.status).toBe(200);
    const body = await r.json();
    const list = Array.isArray(body) ? body : body.data;
    const byId = new Map(list.map((x) => [x.id, x]));

    expect(byId.has(LEAD), "the lead itself is a row").toBe(true);
    for (const [id, parent, depth, name] of [
      [CHILD_A, LEAD, 1, "acceptance-child-a"],
      [CHILD_B, LEAD, 1, "acceptance-child-b"],
      [GRANDCHILD, CHILD_A, 2, "acceptance-grandchild"],
    ]) {
      const row = byId.get(id);
      expect(row, `child ${name} is in /api/sessions`).toBeTruthy();
      expect(row.parentSessionId, `${name} points at its parent`).toBe(parent);
      expect(row.rlmDepth, `${name} reports its depth`).toBe(depth);
      expect(row.name, `${name} carries its name`).toBe(name);
      // B6: name, model, state, last activity
      expect(row.model, `${name} carries a model`).toBeTruthy();
      expect(["active", "ended", "idle", "streaming"]).toContain(row.status);
      expect(typeof row.lastActivityAt).toBe("number");
    }
    // B6 on the model specifically: sidecar said local-qwen/qwen3.8-27b
    expect(byId.get(CHILD_A).model).toContain("qwen3.8-27b");
  });

  it("B2: the WEBSOCKET connect snapshot carries the same children", async () => {
    const snap = await firstSnapshot();
    const byId = new Map(snap.sessions.map((x) => [x.id, x]));
    for (const id of [CHILD_A, CHILD_B, GRANDCHILD]) {
      expect(byId.has(id), `child ${id} rides in sessions_snapshot, not just REST`).toBe(true);
    }
    expect(byId.get(GRANDCHILD).parentSessionId).toBe(CHILD_A);
  });

  it("B1/B2: a child's parent gets a childCount", async () => {
    const rest = await (await fetch(`${base}/api/sessions`)).json();
    const list = Array.isArray(rest) ? rest : rest.data;
    const lead = list.find((x) => x.id === LEAD);
    expect(lead.childCount, "lead reports 2 DIRECT children, not 3 rows").toBe(2);
    const snap = await firstSnapshot();
    expect(snap.sessions.find((x) => x.id === LEAD).childCount).toBe(2);
  });

  it("B7: a finished child is still listed; one past the retention window is not", async () => {
    // the fixture's children are 30 s old, so both `completed` ones are listed
    const list = await (await fetch(`${base}/api/sessions`)).json();
    const arr = Array.isArray(list) ? list : list.data;
    expect(arr.some((x) => x.id === CHILD_B && x.status === "ended"),
      "a just-settled child is still visible").toBe(true);

    // now push one child's transcript 7 h into the past (> the 6 h window)
    const old = (Date.now() - 7 * 3600 * 1000) / 1000;
    utimesSync(join(agentDir, "session-artifacts", LEAD, "sub-bbbb2222", `${CHILD_B}.jsonl`), old, old);
    const after = await (await fetch(`${base}/api/sessions`)).json();
    const arr2 = Array.isArray(after) ? after : after.data;
    expect(arr2.some((x) => x.id === CHILD_B), "a 7 h-old child is dropped").toBe(false);
  });

  it("B8: a lead with no children is untouched — no phantom rows", async () => {
    const solo = mkdtempSync(join(tmpdir(), "acc-solo-"));
    const agent = join(solo, ".prime", "agent");
    mkdirSync(join(agent, "sessions"), { recursive: true });
    writeFileSync(join(agent, "sessions", `${LEAD}.jsonl`), JSON.stringify({
      type: "session", version: 3, id: LEAD, timestamp: "2026-09-30T07:00:00.000Z", cwd: "/projects/solo",
    }) + "\n");
    const prevHome = process.env.HOME, prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = solo; process.env.PI_CODING_AGENT_DIR = agent;
    try {
      const s2 = await createServer({ port: 0, piPort: 0, host: "127.0.0.1", dev: true,
        autoShutdown: false, shutdownIdleSeconds: 999, tunnel: false });
      await s2.start();
      const rows = await (await fetch(`http://127.0.0.1:${s2.httpPort()}/api/sessions`)).json();
      const arr = Array.isArray(rows) ? rows : rows.data;
      expect(arr.every((x) => x.parentSessionId === undefined), "no row claims a parent").toBe(true);
      const leadRow = arr.find((x) => x.id === LEAD);
      expect(leadRow.childCount, "a childless lead has no childCount badge").toBeUndefined();
      await s2.stop?.();
    } finally {
      process.env.HOME = prevHome; process.env.PI_CODING_AGENT_DIR = prevDir;
      rmSync(solo, { recursive: true, force: true });
    }
  });
});

describe("ACCEPTANCE: degradation and no-op", () => {
  it("B9: with NO session-artifacts tree the server behaves exactly as before", async () => {
    const bare = mkdtempSync(join(tmpdir(), "acc-bare-"));
    const agent = join(bare, ".prime", "agent");
    mkdirSync(join(agent, "sessions"), { recursive: true });
    writeFileSync(join(agent, "sessions", `${LEAD}.jsonl`), JSON.stringify({
      type: "session", version: 3, id: LEAD, timestamp: "2026-09-30T07:00:00.000Z", cwd: "/projects/bare",
    }) + "\n");
    const prevHome = process.env.HOME, prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = bare; process.env.PI_CODING_AGENT_DIR = agent;
    try {
      const s = await createServer({ port: 0, piPort: 0, host: "127.0.0.1", dev: true,
        autoShutdown: false, shutdownIdleSeconds: 999, tunnel: false });
      await s.start();
      const rows = await (await fetch(`http://127.0.0.1:${s.httpPort()}/api/sessions`)).json();
      const arr = Array.isArray(rows) ? rows : rows.data;
      expect(arr.length).toBe(1);
      expect(arr[0].id).toBe(LEAD);
      await s.stop?.();
    } finally {
      process.env.HOME = prevHome; process.env.PI_CODING_AGENT_DIR = prevDir;
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("B10: a corrupt sidecar / truncated transcript does not take the list down", async () => {
    const bad = mkdtempSync(join(tmpdir(), "acc-bad-"));
    buildTree(bad);
    const art = join(bad, ".prime", "agent", "session-artifacts");
    // 1. truncated JSON sidecar
    const d1 = join(art, LEAD, "sub-dead001");
    mkdirSync(d1, { recursive: true });
    writeFileSync(join(d1, "rlm-subagent.json"), '{"type":"rlm_subagent","sessionFi');
    writeFileSync(join(d1, "eeeeeeee-5555-4555-8555-555555555555.jsonl"), "{not json\n");
    // 2. sidecar pointing outside its own directory
    const d2 = join(art, LEAD, "sub-dead002");
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d2, "rlm-subagent.json"), JSON.stringify({
      type: "rlm_subagent", status: "running", sessionFile: "../../../../etc/passwd",
    }));
    // 3. a sub- directory with no sidecar at all
    mkdirSync(join(art, LEAD, "sub-dead003"), { recursive: true });
    // 4. a plain file sitting where a directory is expected
    writeFileSync(join(art, LEAD, "sub-dead004"), "not a dir");

    const prevHome = process.env.HOME, prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = bad; process.env.PI_CODING_AGENT_DIR = join(bad, ".prime", "agent");
    try {
      const s = await createServer({ port: 0, piPort: 0, host: "127.0.0.1", dev: true,
        autoShutdown: false, shutdownIdleSeconds: 999, tunnel: false });
      await s.start();
      const res = await fetch(`http://127.0.0.1:${s.httpPort()}/api/sessions`);
      expect(res.status, "the endpoint still answers").toBe(200);
      const rows = await res.json();
      const arr = Array.isArray(rows) ? rows : rows.data;
      // the good children still made it — one bad dir does not poison the scan
      expect(arr.some((x) => x.id === CHILD_A), "good children survive a corrupt sibling").toBe(true);
      // and the corrupt ones contributed no row
      expect(arr.some((x) => String(x.id).startsWith("eeeeeee"))).toBe(false);
      await s.stop?.();
    } finally {
      process.env.HOME = prevHome; process.env.PI_CODING_AGENT_DIR = prevDir;
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it("EDGE: a child whose parent the dashboard does not know gets NO phantom parent row", async () => {
    const orphan = mkdtempSync(join(tmpdir(), "acc-orphan-"));
    buildTree(orphan);
    // delete the lead's own transcript, so the parent is unknown to the server
    rmSync(join(orphan, ".prime", "agent", "sessions", `${LEAD}.jsonl`));
    const prevHome = process.env.HOME, prevDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = orphan; process.env.PI_CODING_AGENT_DIR = join(orphan, ".prime", "agent");
    try {
      const s = await createServer({ port: 0, piPort: 0, host: "127.0.0.1", dev: true,
        autoShutdown: false, shutdownIdleSeconds: 999, tunnel: false });
      await s.start();
      const rows = await (await fetch(`http://127.0.0.1:${s.httpPort()}/api/sessions`)).json();
      const arr = Array.isArray(rows) ? rows : rows.data;
      expect(arr.some((x) => x.id === LEAD), "no invented parent row").toBe(false);
      await s.stop?.();
    } finally {
      process.env.HOME = prevHome; process.env.PI_CODING_AGENT_DIR = prevDir;
      rmSync(orphan, { recursive: true, force: true });
    }
  });
});
