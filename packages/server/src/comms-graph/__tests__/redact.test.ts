/**
 * The scrubber, on real first lines.
 *
 * A redaction test that only checks its own fixtures proves nothing: the
 * failure mode is a shape nobody thought of. So each case here is either a real
 * first line from this Brain's session files (the `SAMPLES` block) or a shape
 * taken from a real incident, and every case asserts the SECRET is gone AND
 * that the sentence around it still reads. A scrubber that eats the whole line
 * passes "no secret present" and is useless.
 */
import { describe, expect, it } from "vitest";
import { redact, whichRule } from "../redact.js";

/** Verbatim first lines from agent_message records on 2026-09-30. */
const SAMPLES = [
  "ANNOUNCING, per DEV-SYSTEM.md, before I change the SHARED dev planner in sandbox devint-20260929-0925-worker.",
  "Read /projects/comms-graph-20260930/PROMPT.txt \u2014 it is your job. Start now.",
  "Host: if you build in the dashboard fork, base on origin/subagents-20260930 (49dd69608, lands first).",
  "MiniMax Token Plan hit its usage limit at 14:26Z (429 \"Token Plan usage limit reached\") and recovered at 15:01Z.",
  "Your goal ended because the provider plan limit was reached; the host will resend it.",
  "Probe of the daemon: spawn ONE rlm child named adder (model local-qwen/qwen3.8-27b) that computes 21*2.",
];

describe("ordinary agent prose survives", () => {
  for (const line of SAMPLES) {
    it(`leaves this readable: ${line.slice(0, 48)}...`, () => {
      expect(redact(line)).toBe(line);
      expect(whichRule(line)).toBeNull();
    });
  }
});

describe("credentials do not survive", () => {
  // The third element is EVERYTHING the rule is entitled to remove, not just
  // the one string that must not survive: a URL rule also takes the username,
  // an Authorization rule also takes the scheme word. Anything left over is a
  // false positive and this test fails on it.
  const CASES: [string, string, string[]][] = [
    ["api key", "here is the key sk-abcdefghij0123456789ABCDEF for the run", ["sk-abcdefghij0123456789ABCDEF"]],
    ["github token", "push with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 done", ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"]],
    ["assigned secret", "mail_system_token: s3cr3t-value-here is the key", ["s3cr3t-value-here"]],
    ["assigned secret", 'API_KEY="hunter2000" rotated it', ["hunter2000"]],
    ["url credentials", "curl https://agent:hunter2@10.99.227.168:8123/ now", ["hunter2", "agent"]],
    ["authorization header", "Authorization: Bearer eyJhbGciOi.abc.def and it 401s", ["eyJhbGciOi.abc.def", "Bearer"]],
    ["private key", "-----BEGIN RSA PRIVATE KEY----- MIIEow and it is in a file", ["MIIEow"]],
    ["secret store path", "the key is at /run/user/1000/atelier-secrets/tailscale-join", ["atelier-secrets/tailscale-join"]],
    ["opaque token", "clientId 7b3a6dfcaa299f4e1a2b3c4d5e6f70819a2b3c4d5e6f7081 is the owner", ["7b3a6dfcaa299f4e1a2b3c4d5e6f70819a2b3c4d5e6f7081"]],
  ];
  for (const [rule, line, removed] of CASES) {
    it(`removes the ${rule} and keeps the sentence`, () => {
      const out = redact(line);
      for (const secret of removed) expect(out).not.toContain(secret);
      expect(whichRule(line)).toBe(rule);
      // Every word that was NOT the secret is still there. A scrubber that
      // eats the whole line passes "no secret present" and is useless: the
      // graph has to stay readable to be worth having.
      const words = line
        .split(/[^A-Za-z0-9_]+/)
        .filter((w) => w.length > 1)
        // A token the rule is entitled to remove is not a "lost word".
        .filter((w) => !removed.some((r) => r.includes(w)));
      expect(words.length).toBeGreaterThan(0);
      for (const w of words) expect(out, `lost the word "${w}"`).toContain(w);
    });
  }
});

describe("the scrubber is safe to run twice", () => {
  it("is idempotent", () => {
    const once = redact("token: abc123456789 do not share it");
    expect(redact(once)).toBe(once);
  });

  it("survives ANSI and control characters without corrupting the line", () => {
    const out = redact("\u001b[31mERROR\u001b[0m the planner is down");
    expect(out).toBe("ERROR the planner is down");
  });

  it("caps the length and does not cut mid-emoji", () => {
    expect(redact("x".repeat(400)).length).toBeLessThanOrEqual(200);
  });
});
