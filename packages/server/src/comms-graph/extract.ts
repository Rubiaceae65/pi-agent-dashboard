/**
 * The comms graph's extraction rules — one function, one JSONL line in.
 *
 * REUSED, NOT REWRITTEN. `/projects/agent-collab-20260930` already extracted this
 * network out of the same files; `artifacts/index2.py` recovers the message
 * graph from `custom_message` records whose `customType` is `agent_message`,
 * reading `details.from` and `details.target`, and `artifacts/index3.py` reads
 * the rlm ledger for parents. This module is that knowledge turned into pure
 * functions with a per-line contract, so it can be tested against fixtures
 * instead of re-run over 68 MB. See artifacts/peer-constraints.md §5 for the
 * line-for-line mapping and artifacts/checks.json for the counts.
 *
 * WHAT IS NEW HERE, and why it is not in agent-collab's report:
 *   - `agent_status.taskState`, which is where "working / idle / error" comes
 *     from (agent-collab counted turns, not state).
 *   - `custom/thread_goal_state`, the goal status per node.
 *   - `custom/atelier-prime-relay`, which is the only durable trace a relay
 *     leaves in a session file besides the successor's name.
 *
 * Everything here is pure: no fs, no clock, no daemon. `indexer.ts` owns all
 * three. That split is what makes the tests above meaningful.
 */

/** What an endpoint is, as far as the FILE can prove. */
export type EndpointKind = "lead" | "subagent" | "external";

export interface Endpoint {
  /**
   * The stable identity of one end of an edge.
   *
   * A session's NAME is the key when it has one, because that is what a human
   * reads in the graph and what a relay successor is matched by. A session id is
   * the key otherwise, and a `client:<id>` key for a sender with no session at
   * all. The id is carried alongside so the indexer can upgrade a key from
   * `01a0…` to a real name once it has read that session's `session_info`.
   */
  key: string;
  name: string | null;
  sessionId: string | null;
  clientId: string | null;
  kind: EndpointKind;
}

export type LineFact =
  | { kind: "session"; sessionId: string; depth: number; cwd: string | null }
  | { kind: "name"; name: string }
  | { kind: "model"; model: string }
  | { kind: "session_state"; state: string }
  | { kind: "agent_status"; taskState: string; summary: string | null }
  | { kind: "goal"; status: string; objective: string | null; tokensUsed: number }
  | { kind: "relay_fired"; at: string | null }
  | {
      kind: "message";
      from: Endpoint;
      to: Endpoint;
      messageId: string | null;
      at: string;
      firstLine: string;
    };

/** Hard cap on a first line, in characters. Long prose is a UI problem, not a
 *  memory one, but the cap is also what keeps a 3 MB message from becoming a
 *  3 MB ring entry. */
export const FIRST_LINE_MAX = 200;

/**
 * The first line of a message, and only the first line.
 *
 * The job's constraint is not "shorten messages", it is "never show a body":
 * an agent message routinely carries a prompt, a path, and a claim about a
 * shared instance. Whitespace inside the line is collapsed so a wrapped line
 * does not render as two, and the `[agent-message from X]` envelope — which the
 * daemon puts at the top of `content` but NOT at the top of `details.message`
 * — is never shown twice.
 */
export function firstLine(body: string, max = FIRST_LINE_MAX): string {
  for (const raw of String(body ?? "").split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length > 0) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return "";
}

/** Read `details.from` / `details.target` into an Endpoint. */
function endpoint(side: unknown, fallbackSessionId: string | null, fileDepth: number): Endpoint {
  const s = (side ?? {}) as Record<string, unknown>;
  const name = typeof s.sessionName === "string" && s.sessionName.length > 0 ? s.sessionName : null;
  const sessionId = typeof s.sessionId === "string" && s.sessionId.length > 0 ? s.sessionId : null;
  const clientId = typeof s.clientId === "string" && s.clientId.length > 0 ? s.clientId : null;
  const runtimeKind = typeof s.runtimeKind === "string" ? s.runtimeKind : null;

  if (name) {
    // `runtimeKind` is "top-level" or "subagent"; the file's own depth is the
    // fallback because a `session_info`-less child (some exist) has no
    // runtimeKind on the wire at all.
    const kind: EndpointKind = runtimeKind === "subagent" || fileDepth > 0 ? "subagent" : "lead";
    return { key: name, name, sessionId, clientId, kind };
  }
  if (sessionId) {
    const kind: EndpointKind = runtimeKind === "subagent" || fileDepth > 0 ? "subagent" : "lead";
    return { key: sessionId, name: null, sessionId, clientId, kind };
  }
  if (clientId) {
    // A sender that is not a session at all: the host, the owner, a tunnel.
    // The files do not say which, so the key is the clientId and the label
    // says exactly that. Guessing "host" here would put a node in the graph
    // that the evidence does not support.
    return { key: `client:${clientId}`, name: null, sessionId: null, clientId, kind: "external" };
  }
  // No identity whatsoever. The file's own id is the last honest answer.
  return {
    key: fallbackSessionId ?? "unknown",
    name: null,
    sessionId: fallbackSessionId,
    clientId: null,
    kind: "lead",
  };
}

/**
 * One JSONL line in, one fact out — or `null` for every record this module does
 * not claim.
 *
 * `fileDepth` is the session's `rlmDepth` from its header record, which the
 * indexer has already read by the time any message in that file arrives. It is
 * passed in rather than remembered so that `extractLine` stays pure.
 */
export function extractLine(line: string, fileSessionId: string, fileDepth = 0): LineFact | null {
  if (!line) return null;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = d.type;
  const ts = typeof d.timestamp === "string" ? d.timestamp : null;

  if (type === "session") {
    const id = typeof d.id === "string" ? d.id : fileSessionId;
    return {
      kind: "session",
      sessionId: id,
      depth: typeof d.rlmDepth === "number" ? d.rlmDepth : 0,
      cwd: typeof d.cwd === "string" ? d.cwd : null,
    };
  }
  if (type === "session_info") {
    const name = typeof d.name === "string" ? d.name : null;
    return name ? { kind: "name", name } : null;
  }
  if (type === "model_change") {
    const provider = typeof d.provider === "string" ? d.provider : null;
    const modelId = typeof d.modelId === "string" ? d.modelId : null;
    if (!modelId) return null;
    return { kind: "model", model: provider ? `${provider}/${modelId}` : modelId };
  }
  if (type === "session_state") {
    const state = typeof d.state === "string" ? d.state : null;
    return state ? { kind: "session_state", state } : null;
  }
  if (type === "agent_status") {
    const st = (d.status ?? {}) as Record<string, unknown>;
    const taskState = typeof st.taskState === "string" ? st.taskState : null;
    if (!taskState) return null;
    return {
      kind: "agent_status",
      taskState,
      summary: typeof st.summary === "string" ? st.summary : null,
    };
  }
  if (type === "custom") {
    const data = (d.data ?? {}) as Record<string, unknown>;
    if (d.customType === "thread_goal_state") {
      const status = typeof data.status === "string" ? data.status : null;
      if (!status) return null;
      return {
        kind: "goal",
        status,
        objective: typeof data.objective === "string" ? data.objective : null,
        tokensUsed: typeof data.tokensUsed === "number" ? data.tokensUsed : 0,
      };
    }
    if (d.customType === "atelier-prime-relay") {
      return { kind: "relay_fired", at: typeof data.at === "string" ? data.at : ts };
    }
    return null;
  }
  if (type === "custom_message" && d.customType === "agent_message") {
    const details = (d.details ?? {}) as Record<string, unknown>;
    const body = typeof details.message === "string" ? details.message : "";
    return {
      kind: "message",
      from: endpoint(details.from, fileSessionId, 0),
      to: endpoint(details.target, fileSessionId, fileDepth),
      messageId: typeof details.id === "string" ? details.id : null,
      at: ts ?? new Date(0).toISOString(),
      firstLine: firstLine(body),
    };
  }
  return null;
}

/** The minimum a node needs for the relay rule to run over it. */
export interface RelayCandidate {
  key: string;
  name: string;
  cwd: string | null;
  startedAt: string;
  /** Set when this session's own file carries `custom/atelier-prime-relay`. */
  relayFiredAt?: string | null;
}

const RELAY_SUFFIX = /^(.*)-(\d+)$/;

/**
 * Relay edges: predecessor → `-N` successor, in the same directory.
 *
 * THE HONEST VERSION OF THIS RULE. A relay successor is a NEW depth-0 session
 * created by `rlm.create_session`, so nothing in either file says "this one
 * replaces that one". Three things together make the pairing defensible and all
 * three are required:
 *
 *   1. the successor's name is `<name>-<n>` — the relay extension's own naming,
 *      `/etc/atelier/prime/atelier-prime-relay.ts`;
 *   2. the predecessor's own file carries `custom/atelier-prime-relay` with
 *      `fired: true` — proof that THIS session handed off, not merely that a
 *      similarly-named session exists;
 *   3. the successor started after the notice fired, in the same cwd.
 *
 * A `-2` session with no firing predecessor is left unpaired rather than
 * guessed at, and the graph shows it as an ordinary lead. That is the correct
 * failure: a missing edge is visible, a wrong edge is not.
 */
export function resolveEndpoints(nodes: readonly RelayCandidate[]): { kind: "relay"; from: string; to: string }[] {
  const out: { kind: "relay"; from: string; to: string }[] = [];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  for (const node of nodes) {
    if (!node.relayFiredAt) continue;
    const successors = nodes.filter((other) => {
      if (other.key === node.key) return false;
      const m = RELAY_SUFFIX.exec(other.name);
      if (!m || m[1] !== node.name) return false;
      if (node.cwd && other.cwd && node.cwd !== other.cwd) return false;
      if (Date.parse(other.startedAt) < Date.parse(node.relayFiredAt as string)) return false;
      return true;
    });
    // Lowest matching `-n` wins: a relay chain `-2` → `-3` has two notices and
    // one `-3`; the `-3` must hang off the `-2`, not the `-1`.
    successors.sort((a, b) => (Number(REGEX_TAIL(a.name)) || 0) - (Number(REGEX_TAIL(b.name)) || 0));
    const next = successors[0];
    if (next && !out.some((e) => e.to === next.key)) {
      out.push({ kind: "relay", from: byKey.get(node.key)!.key, to: next.key });
    }
  }
  return out;
}

function REGEX_TAIL(name: string): string {
  return RELAY_SUFFIX.exec(name)?.[2] ?? "";
}
