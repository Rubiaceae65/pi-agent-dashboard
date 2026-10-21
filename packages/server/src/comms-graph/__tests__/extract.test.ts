/**
 * The extraction rules, on FIXED fixtures — the failing-first half.
 *
 * Every rule in `extract.ts` is a claim about the shape of a real session file.
 * A claim about a file format is only worth what a fixture for it is worth, so
 * each test here names the record it is copying and fails if the rule stops
 * matching it. The records are taken verbatim (with the long prose truncated)
 * from `/home/agent/.prime/agent/sessions` on 2026-09-30, and their provenance
 * is in `artifacts/checks.json`.
 *
 * The rules themselves are REUSED, not invented: `/projects/agent-collab-20260930`
 * recovered the same graph in `artifacts/index2.py` (custom_message/
 * customType=agent_message -> details.from|target) and `artifacts/index3.py`
 * (the rlm ledger for parents). Where this module needs a fact agent-collab did
 * not take, it says so in a comment rather than pretending it came from there.
 */
import { describe, expect, it } from "vitest";
import { extractLine, firstLine, resolveEndpoints } from "../extract.js";

const OWNER = "01a0e8a9-17a0-731c-a0d2-5659947f920f";

describe("extractLine — the record kinds the graph is made of", () => {
  it("reads the session header: id, rlm depth, cwd", () => {
    // verbatim first line of a depth-1 child
    const fact = extractLine(
      '{"type":"session","version":3,"id":"01a0e928-729d-7494-ae1e-c32d4307307a","timestamp":"2026-09-29T09:02:11.004Z","cwd":"/projects/brain2-parity-20260930","rlmDepth":1}',
      OWNER,
    );
    expect(fact).toEqual({
      kind: "session",
      sessionId: "01a0e928-729d-7494-ae1e-c32d4307307a",
      depth: 1,
      cwd: "/projects/brain2-parity-20260930",
    });
  });

  it("reads the name a session was given (session_info)", () => {
    const fact = extractLine(
      '{"type":"session_info","id":"b6c5f442","parentId":"c01ead47","timestamp":"2026-09-29T11:22:17.278Z","name":"primeprobe"}',
      OWNER,
    );
    expect(fact).toEqual({ kind: "name", name: "primeprobe" });
  });

  it("reads the model as provider/id; LAST-wins is the indexer's job, not this one's", () => {
    expect(
      extractLine('{"type":"model_change","timestamp":"2026-09-29T11:22:17.278Z","provider":"openrouter","modelId":"mimo"}', OWNER),
    ).toEqual({ kind: "model", model: "openrouter/mimo" });
    expect(
      extractLine('{"type":"model_change","timestamp":"2026-09-29T12:00:00.000Z","provider":"local-qwen","modelId":"qwen3.8-27b"}', OWNER),
    ).toEqual({ kind: "model", model: "local-qwen/qwen3.8-27b" });
  });

  it("reads the working state, including the error the plan limit produced", () => {
    const fact = extractLine(
      '{"type":"agent_status","id":"ece970b0","parentId":"1534a62a","timestamp":"2026-09-30T01:12:19.797Z","status":{"summary":"Model request failed: Provider rate limit exceeded (rate_limit_error, 429): Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)","taskState":"error","basedOnMessageCount":135}}',
      OWNER,
    );
    expect(fact).toMatchObject({ kind: "agent_status", taskState: "error" });
  });

  it("reads the thread goal (custom/thread_goal_state, not custom_message)", () => {
    const fact = extractLine(
      '{"type":"custom","customType":"thread_goal_state","data":{"active":true,"status":"active","goalId":"72a1ef8c","objective":"Probe of the daemon: spawn ONE rlm child.","tokensUsed":0},"timestamp":"2026-09-29T11:21:52.300Z"}',
      OWNER,
    );
    expect(fact).toEqual({
      kind: "goal",
      status: "active",
      objective: "Probe of the daemon: spawn ONE rlm child.",
      tokensUsed: 0,
    });
  });

  it("reads the relay-fired notice, which is how a relay edge is corroborated", () => {
    const fact = extractLine(
      '{"type":"custom","customType":"atelier-prime-relay","data":{"fired":true,"percent":13.301666666666668,"threshold":0.05,"at":"2026-09-29T12:06:00.052Z"},"timestamp":"2026-09-29T12:06:00.052Z"}',
      OWNER,
    );
    expect(fact).toEqual({ kind: "relay_fired", at: "2026-09-29T12:06:00.052Z" });
  });

  it("reads a delivered agent_message and resolves BOTH ends to stable keys", () => {
    const fact = extractLine(
      '{"type":"custom_message","customType":"agent_message","content":"[agent-message from mail-consumer-rework-20260930]\\n\\nANNOUNCING...","id":"9","parentId":"8","timestamp":"2026-09-30T09:05:08.472Z","details":{"id":"agentmsg_c9452f0b","message":"ANNOUNCING, per DEV-SYSTEM.md.","from":{"activeSessionId":"5a1a718bf74e","sessionId":"01a0efa3-b603-730f-a3fd-d52e60fc6e95","sessionName":"mail-consumer-rework-20260930","runtimeKind":"top-level","clientId":"daemon-client:e37fa8a9"},"target":{"activeSessionId":"64c580639622","sessionId":"01a0e8a9-17a0-731c-a0d2-5659947f920f","runtimeKind":"top-level"}}}',
      OWNER,
    );
    expect(fact).toMatchObject({
      kind: "message",
      from: { key: "mail-consumer-rework-20260930", name: "mail-consumer-rework-20260930", kind: "lead" },
      // the target has NO sessionName — 257 of 773 real records look like this.
      // Falling back to the file's own session id is what makes those edges
      // appear at all; the graph resolves the id to a name later.
      to: { key: OWNER, name: null, kind: "lead", sessionId: OWNER },
      messageId: "agentmsg_c9452f0b",
      firstLine: "ANNOUNCING, per DEV-SYSTEM.md.",
    });
  });

  it("labels a message from outside the estate by its clientId, not by a guess", () => {
    // 257 real records have `from` with a clientId and NOTHING else. Calling
    // that "the host" or "the owner" would be a guess; the files do not say.
    const fact = extractLine(
      '{"type":"custom_message","customType":"agent_message","content":"[agent-message]\\n\\nStart now: work toward your goal.","timestamp":"2026-09-30T11:00:00.000Z","details":{"id":"agentmsg_967a","message":"Start now: work toward your goal.","from":{"clientId":"7b3a6dfcaa29"},"target":{"activeSessionId":"b4d360d4a6ab","sessionId":"01a0ece6-5097-7227-96f0-8a85a1778750","sessionName":"primeprobe","runtimeKind":"top-level"}}}',
      OWNER,
    );
    expect(fact).toMatchObject({
      kind: "message",
      from: { key: "client:7b3a6dfcaa29", name: null, kind: "external" },
      to: { key: "primeprobe", name: "primeprobe", kind: "lead" },
      firstLine: "Start now: work toward your goal.",
    });
  });

  it("returns null for every record it does not claim, rather than guessing", () => {
    for (const line of [
      '{"type":"child_usage_attributed","timestamp":"2026-09-29T11:00:00.000Z","aggregateUsage":{"inputTokens":5}}',
      '{"type":"custom","customType":"harness_digest","data":{"digest":"# Continual Harness State"},"timestamp":"2026-09-29T11:00:00.000Z"}',
      '{"type":"custom_message","customType":"async_bash_completion","content":"ok","timestamp":"2026-09-29T11:00:00.000Z"}',
      '{"type":"compaction","timestamp":"2026-09-29T11:00:00.000Z"}',
      "not json at all",
      "",
    ]) {
      expect(extractLine(line, OWNER), line).toBeNull();
    }
  });
});

describe("firstLine — the graph shows a message's first line, never its body", () => {
  it("takes the first non-empty line, collapses whitespace, and caps the length", () => {
    expect(firstLine("  \n  ANNOUNCING, per DEV-SYSTEM.md.\n\nWHO/WHAT: ...  ")).toBe(
      "ANNOUNCING, per DEV-SYSTEM.md.",
    );
    expect(firstLine("x".repeat(500)).length).toBe(200);
  });

  it("survives a message that is only whitespace", () => {
    expect(firstLine("   \n\t\n")).toBe("");
  });
});

describe("resolveEndpoints — the relay edge, and why it is a corroborated guess", () => {
  it("pairs a session that fired the relay notice with its `-N` successor", () => {
    // The session files record that the relay FIRED but never name the
    // successor; `rlm.create_session` is only visible as a tool call in the
    // parent's transcript. The pairing rule is therefore: same cwd, name is
    // `<base>-<n>`, the base names a session that fired the notice, and the
    // successor started after it. Stated as a rule, tested as a rule.
    const nodes = [
      { key: "comms-graph-20260930", name: "comms-graph-20260930", cwd: "/projects/comms-graph-20260930", startedAt: "2026-09-30T14:24:44.000Z", relayFiredAt: "2026-09-30T15:00:00.000Z" },
      { key: "comms-graph-20260930-2", name: "comms-graph-20260930-2", cwd: "/projects/comms-graph-20260930", startedAt: "2026-09-30T15:03:00.000Z" },
    ];
    expect(resolveEndpoints(nodes)).toEqual([
      { kind: "relay", from: "comms-graph-20260930", to: "comms-graph-20260930-2" },
    ]);
  });

  it("refuses to pair two ordinary sessions that merely share a name stem", () => {
    const nodes = [
      { key: "a", name: "a", cwd: "/projects/x", startedAt: "2026-09-30T14:00:00.000Z" },
      { key: "a-2", name: "a-2", cwd: "/projects/y", startedAt: "2026-09-30T15:00:00.000Z" },
    ];
    expect(resolveEndpoints(nodes)).toEqual([]);
  });

  it("refuses to pair a `-2` that started BEFORE the notice fired", () => {
    const nodes = [
      { key: "a", name: "a", cwd: "/projects/x", startedAt: "2026-09-30T14:00:00.000Z", relayFiredAt: "2026-09-30T16:00:00.000Z" },
      { key: "a-2", name: "a-2", cwd: "/projects/x", startedAt: "2026-09-30T15:00:00.000Z" },
    ];
    expect(resolveEndpoints(nodes)).toEqual([]);
  });
});
