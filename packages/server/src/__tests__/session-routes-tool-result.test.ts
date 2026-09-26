/**
 * GET /api/sessions/:sessionId/tool-result/:toolCallId returns the full
 * stored tool result, 404 when in-flight or evicted.
 *
 * See change: adopt-pi-071-072-073-features (C.1).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryEventStore, type EventStore } from "../persistence/memory-event-store.js";
import { registerSessionRoutes } from "../routes/session-routes.js";

const PASSTHRU_GUARD = async () => {};

function makeSessionManager(): any {
  return { listAll: () => [], get: () => undefined };
}

describe("GET /api/sessions/:sessionId/tool-result/:toolCallId", () => {
  let fastify: FastifyInstance;
  let eventStore: EventStore;

  beforeEach(async () => {
    eventStore = createMemoryEventStore(() => false);
    fastify = Fastify();
    registerSessionRoutes(fastify, {
      sessionManager: makeSessionManager(),
      eventStore,
      networkGuard: PASSTHRU_GUARD,
    });
    await fastify.ready();
  });

  afterEach(async () => {
    if (fastify) await fastify.close();
  });

  it("returns 200 with the full result for a completed tool call", async () => {
    eventStore.insertEvent("s1", {
      eventType: "tool_execution_end",
      timestamp: 1,
      data: { toolCallId: "t1", result: "full output here", isError: false },
    });
    const res = await fastify.inject({ method: "GET", url: "/api/sessions/s1/tool-result/t1" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.result).toBe("full output here");
    expect(body.isError).toBe(false);
  });

  it("returns 404 for an in-flight tool call (no end event)", async () => {
    eventStore.insertEvent("s1", {
      eventType: "tool_execution_start",
      timestamp: 1,
      data: { toolCallId: "t2", toolName: "bash", args: {} },
    });
    const res = await fastify.inject({ method: "GET", url: "/api/sessions/s1/tool-result/t2" });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toMatch(/in flight|unknown/);
  });

  it("returns 404 for an evicted / unknown session", async () => {
    const res = await fastify.inject({ method: "GET", url: "/api/sessions/ghost/tool-result/t3" });
    expect(res.statusCode).toBe(404);
  });
});

// disk-fallback-for-tool-result-route: ended / historical sessions have their
// toolResult rows only in the on-disk JSONL; the in-memory store has no
// entry. Without the disk fallback, every historical tool call 404s and
// useStaleToolReconcile re-fires forever → permanent content-replay storm.
describe("GET /api/sessions/:sessionId/tool-result/:toolCallId — disk fallback", () => {
  let tmpDir: string;
  let sessionFile: string;

  function managerWith(sessionFileById: Record<string, string | undefined>): any {
    return {
      listAll: () => [],
      get: (id: string) =>
        id in sessionFileById ? { id, cwd: "/tmp", sessionFile: sessionFileById[id] } : undefined,
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tool-result-disk-"));
    sessionFile = join(tmpDir, "s.jsonl");
  });

  afterEach(async () => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  async function build(manager: any): Promise<FastifyInstance> {
    const f = Fastify();
    registerSessionRoutes(f, {
      sessionManager: manager,
      eventStore: createMemoryEventStore(() => false),
      networkGuard: PASSTHRU_GUARD,
    });
    await f.ready();
    return f;
  }

  function writeSession(entries: object[]): void {
    writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  it("returns 200 with the disk-stored result when no in-memory end event exists", async () => {
    writeSession([
      { type: "session", id: "s1", cwd: "/tmp" },
      {
        type: "message",
        id: "e1",
        parentId: null,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-1", name: "ipython" }],
        },
      },
      {
        type: "message",
        id: "e2",
        parentId: "e1",
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "ipython",
          isError: false,
          content: [{ type: "text", text: "42\n" }],
        },
      },
    ]);
    const f = await build(managerWith({ s1: sessionFile }));
    try {
      const res = await f.inject({ method: "GET", url: "/api/sessions/s1/tool-result/tc-1" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe("42\n");
      expect(body.isError).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("preserves isError=true from the disk-stored toolResult", async () => {
    writeSession([
      { type: "session", id: "s1", cwd: "/tmp" },
      {
        type: "message",
        id: "e2",
        parentId: null,
        message: {
          role: "toolResult",
          toolCallId: "tc-fail",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "boom" }],
        },
      },
    ]);
    const f = await build(managerWith({ s1: sessionFile }));
    try {
      const res = await f.inject({ method: "GET", url: "/api/sessions/s1/tool-result/tc-fail" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.isError).toBe(true);
      expect(body.result).toBe("boom");
    } finally {
      await f.close();
    }
  });

  it("joins multi-part content (text + image markers) into a single result string", async () => {
    writeSession([
      { type: "session", id: "s1", cwd: "/tmp" },
      {
        type: "message",
        id: "e2",
        parentId: null,
        message: {
          role: "toolResult",
          toolCallId: "tc-multi",
          toolName: "read",
          isError: false,
          content: [
            { type: "text", text: "before-image\n" },
            { type: "image" },
            { type: "text", text: "after-image\n" },
          ],
        },
      },
    ]);
    const f = await build(managerWith({ s1: sessionFile }));
    try {
      const res = await f.inject({ method: "GET", url: "/api/sessions/s1/tool-result/tc-multi" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe("before-image\n[image]after-image\n");
    } finally {
      await f.close();
    }
  });

  it("returns 404 when the JSONL exists but no matching toolResult", async () => {
    writeSession([
      { type: "session", id: "s1", cwd: "/tmp" },
      {
        type: "message",
        id: "e1",
        parentId: null,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "tc-other", name: "bash" }],
        },
      },
    ]);
    const f = await build(managerWith({ s1: sessionFile }));
    try {
      const res = await f.inject({ method: "GET", url: "/api/sessions/s1/tool-result/tc-1" });
      expect(res.statusCode).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("returns 404 when the session has no sessionFile (live bridge only)", async () => {
    const f = await build(managerWith({ s1: undefined }));
    try {
      const res = await f.inject({ method: "GET", url: "/api/sessions/s1/tool-result/tc-1" });
      expect(res.statusCode).toBe(404);
    } finally {
      await f.close();
    }
  });

  it("in-memory result wins over disk when both have the same toolCallId", async () => {
    writeSession([
      { type: "session", id: "s1", cwd: "/tmp" },
      {
        type: "message",
        id: "e2",
        parentId: null,
        message: {
          role: "toolResult",
          toolCallId: "tc-1",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "disk-version" }],
        },
      },
    ]);
    const f = await build(managerWith({ s1: sessionFile }));
    // Inject an in-memory end event with a different result after build.
    const eventStore = (f as any).eventStore ?? null;
    // Reach into the fastify instance: the routes store eventStore by closure,
    // so we need a separate path. Use a fresh fastify with both stores.
    await f.close();
    const f2 = Fastify();
    const store = createMemoryEventStore(() => false);
    store.insertEvent("s1", {
      eventType: "tool_execution_end",
      timestamp: 1,
      data: { toolCallId: "tc-1", result: "memory-version", isError: false },
    });
    registerSessionRoutes(f2, { sessionManager: managerWith({ s1: sessionFile }), eventStore: store, networkGuard: PASSTHRU_GUARD });
    await f2.ready();
    try {
      const res = await f2.inject({ method: "GET", url: "/api/sessions/s1/tool-result/tc-1" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.result).toBe("memory-version");
    } finally {
      await f2.close();
    }
  });
});

// opt-in-out-of-cwd-session-diffs: GET /api/session-change/:sessionId/:toolCallId
describe("GET /api/session-change/:sessionId/:toolCallId", () => {
  let fastify: FastifyInstance;
  let tmpDir: string;
  let sessionFile: string;

  function managerWith(sessionFileById: Record<string, string | undefined>): any {
    return { listAll: () => [], get: (id: string) => (id in sessionFileById ? { id, cwd: "/tmp", sessionFile: sessionFileById[id] } : undefined) };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-change-"));
    sessionFile = join(tmpDir, "s.jsonl");
    writeFileSync(
      sessionFile,
      [
        { type: "session", id: "s1", cwd: "/tmp" },
        { type: "message", id: "e1", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "tc-1", name: "write", arguments: { path: "/tmp/out.txt", content: "FULL" } }] } },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  });

  afterEach(async () => {
    if (fastify) await fastify.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function build(manager: any): Promise<FastifyInstance> {
    const f = Fastify();
    registerSessionRoutes(f, { sessionManager: manager, eventStore: createMemoryEventStore(() => false), networkGuard: PASSTHRU_GUARD });
    await f.ready();
    return f;
  }

  it("returns 200 with the full payload for a known tool call", async () => {
    fastify = await build(managerWith({ s1: sessionFile }));
    const res = await fastify.inject({ method: "GET", url: "/api/session-change/s1/tc-1" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.content).toBe("FULL");
  });

  it("E6 — returns 404 for an unknown toolCallId", async () => {
    fastify = await build(managerWith({ s1: sessionFile }));
    const res = await fastify.inject({ method: "GET", url: "/api/session-change/s1/tc-missing" });
    expect(res.statusCode).toBe(404);
  });

  it("E7 — SECURITY: resolves only via sessionManager.sessionFile (no path built from sessionId)", async () => {
    // A path-looking / traversal sessionId that is NOT a registered session
    // must 404 — the route never constructs a filesystem path from the id.
    fastify = await build(managerWith({ s1: sessionFile }));
    const res = await fastify.inject({
      method: "GET",
      url: `/api/session-change/${encodeURIComponent("../../etc/passwd")}/tc-1`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when the session has no sessionFile", async () => {
    fastify = await build(managerWith({ s1: undefined }));
    const res = await fastify.inject({ method: "GET", url: "/api/session-change/s1/tc-1" });
    expect(res.statusCode).toBe(404);
  });
});

// surface-historical-sessions: GET /api/sessions merges live + disk-scanned
// sessions and orders them newest-first.
describe("GET /api/sessions — live + disk merge", () => {
  function managerWithList(list: any[]): any {
    return { listAll: () => list, get: () => undefined };
  }

  async function buildWithList(list: any[]): Promise<FastifyInstance> {
    const f = Fastify();
    registerSessionRoutes(f, {
      sessionManager: managerWithList(list),
      eventStore: createMemoryEventStore(() => false),
      networkGuard: PASSTHRU_GUARD,
    });
    await f.ready();
    return f;
  }

  it("returns live sessions even when they have no sessionFile", async () => {
    // A bridge-registered session with id but no resolved file must still
    // appear in the listing — a filter on sessionFile would drop it.
    const f = await buildWithList([
      { id: "live-1", cwd: "/tmp", status: "active", startedAt: 1000 },
    ]);
    try {
      const res = await f.inject({ method: "GET", url: "/api/sessions" });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe("live-1");
    } finally {
      await f.close();
    }
  });

  it("merges live and scanned sessions, live wins on id collision, sorted newest-first", async () => {
    const f = await buildWithList([
      // Live: id collision with disk — must win (newer startedAt).
      { id: "shared", cwd: "/live", status: "active", startedAt: 2000, sessionFile: "/live/shared.jsonl" },
      // Live: id only, no file — must still be included.
      { id: "live-only", cwd: "/live-only", status: "active", startedAt: 500 },
    ]);
    try {
      const res = await f.inject({ method: "GET", url: "/api/sessions" });
      const body = JSON.parse(res.payload);
      expect(body.data.map((s: any) => s.id)).toEqual(["shared", "live-only"]);
      expect(body.data[0].cwd).toBe("/live"); // live overwrite
      expect(body.data[0].status).toBe("active");
    } finally {
      await f.close();
    }
  });
});
