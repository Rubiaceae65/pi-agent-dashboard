/**
 * format.js — turn ANY value the dashboard API can hand us into readable text.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The first phone client had one line doing all of this:
 *
 *     if (d.message) return String(d.message);
 *
 * The stream does not send a string there. `message_start` / `message_update`
 * carry `data.message` = `{ role, content: [ {type:"text",text}, … ], usage, … }`
 * — an object whose `content` is an ARRAY of blocks. `String()` on it is
 * literally "[object Object]", which is what the owner saw on the phone:
 * 29 of them in a single session view, measured 2026-09-30 against the live
 * dashboard at 390x844 (shots/before/, artifacts/api-payloads.md).
 *
 * The same trap exists for every other object-shaped field: `usage`,
 * `turnUsage`, `contextUsage`, `model`, `args`, `details`, `cost`. The rule
 * this module enforces is therefore not "handle the fields we know" but
 * "no code path may ever produce `[object …]`, `undefined` or `NaN`", and the
 * second half of that rule is "and must not silently DROP what it cannot
 * render" — an unknown shape is printed in full, indented, with its keys.
 *
 * Every function here is pure and total: no throw, no cycle, bounded depth and
 * bounded width, and a value it cannot interpret is still reported.
 */

/** Longest single string we will print before summarising it. */
const MAX_STRING = 400;
/** Deepest object nesting we will descend before summarising. */
const MAX_DEPTH = 4;
/** Guard against a self-referential payload. */
const MAX_ITEMS = 50;

const isPlain = (v) => typeof v === "object" && v !== null;

/**
 * A value -> readable text, ALWAYS. Never "[object Object]", never
 * "undefined", never "NaN".
 */
export function fmt(value, depth = 0, key = "") {
  if (value === null) return "(null)";
  if (value === undefined) return "(absent)";
  const t = typeof value;
  if (t === "string") return clip(value);
  if (t === "number") return Number.isFinite(value) ? String(value) : `(${String(value)})`;
  if (t === "boolean") return value ? "yes" : "no";
  if (t === "bigint") return `${value}n`;
  if (t === "function") return "(function)";
  if (t === "symbol") return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty list)";
    if (depth >= MAX_DEPTH) return `(list of ${value.length})`;
    const head = value.slice(0, MAX_ITEMS).map((v) => fmt(v, depth + 1));
    const more = value.length > MAX_ITEMS ? [`… ${value.length - MAX_ITEMS} more`] : [];
    return [...head, ...more].join(", ");
  }

  // object
  if (depth >= MAX_DEPTH) return `(${countKeys(value)} keys)`;
  const keys = Object.keys(value);
  if (keys.length === 0) return "(empty object)";
  const parts = keys.slice(0, MAX_ITEMS).map((k) => `${k}: ${fmt(value[k], depth + 1, k)}`);
  if (keys.length > MAX_ITEMS) parts.push(`… ${keys.length - MAX_ITEMS} more keys`);
  const indent = "  ".repeat(Math.max(0, depth - 1));
  return "\n" + indent + parts.join("\n" + indent);
}

function countKeys(o) {
  try {
    return Object.keys(o).length;
  } catch {
    return 0;
  }
}

/** Shorten a long string but SAY that we did, with the real length. */
function clip(s) {
  if (s.length <= MAX_STRING) return s;
  return `${s.slice(0, MAX_STRING)}… [${s.length} chars total]`;
}

/**
 * The name to show for a session — the same precedence the desktop client uses
 * in `getSessionDisplayName` (session-display-name.ts): name, then the first
 * message, then the basename of the cwd, then a short id.
 *
 * This exists because `title` is NOT a DashboardSession field (types.ts), yet
 * the PoC read `s.title` first — so for every session without an explicit name
 * the phone drew a raw 36-character UUID as the session's identity.
 */
export function sessionName(s) {
  return label(
    s.name ?? s.firstMessage ?? (typeof s.cwd === "string" ? s.cwd.split("/").filter(Boolean).pop() : undefined),
    String(s.id ?? "").slice(0, 8) || "(unnamed session)",
  );
}

/** A one-line label for a session row: never empty, never "[object …]". */
export function label(value, fallback) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (isPlain(value)) {
    for (const k of ["title", "name", "id", "label", "text"]) {
      if (typeof value[k] === "string" && value[k].trim()) return value[k].trim();
    }
  }
  return fallback;
}

/**
 * One message object -> a list of {cls, text} lines.
 * `content` is an ARRAY of blocks; older/other producers send a bare string.
 * Every block kind is rendered: nothing is dropped.
 */
export function messageLines(message) {
  const out = [];
  if (typeof message === "string") {
    out.push({ cls: "text", text: clip(message) });
    return out;
  }
  if (!isPlain(message)) {
    out.push({ cls: "text", text: fmt(message) });
    return out;
  }
  const content = message.content;
  if (typeof content === "string" || content === undefined || content === null) {
    if (typeof message.text === "string") out.push({ cls: "text", text: clip(message.text) });
  } else if (Array.isArray(content)) {
    for (const block of content) out.push(...blockLines(block));
  } else {
    out.push({ cls: "text", text: `content: ${fmt(content)}` });
  }
  if (out.length === 0) out.push({ cls: "meta", text: `(${label(message.role, "message")} with no renderable content)` });
  if (message.errorMessage) out.push({ cls: "err", text: `error: ${clip(String(message.errorMessage))}` });
  if (message.stopReason && message.stopReason !== "stop" && !message.errorMessage) {
    out.push({ cls: "meta", text: `stopReason: ${fmt(message.stopReason)}` });
  }
  if (isPlain(message.usage)) {
    const u = message.usage;
    out.push({
      cls: "meta",
      text: `usage: in ${fmt(u.input)} · out ${fmt(u.output)} · cacheRead ${fmt(u.cacheRead)} · cacheWrite ${fmt(u.cacheWrite)}`,
    });
  }
  return out;
}

/** One content block -> lines. Unknown block kinds are printed, not skipped. */
export function blockLines(block) {
  if (!isPlain(block)) return [{ cls: "text", text: fmt(block) }];
  switch (block.type) {
    case "text":
      // `text` is a string in every shape seen on the wire, but a producer that
      // puts an ARRAY of lines there must still render readably rather than
      // through String() — that is the same bug one level down.
      return [{ cls: "text", text: typeof block.text === "string" ? clip(block.text) : fmt(block.text) }];
    case "thinking":
      // Redacted thinking blocks carry the text in a signature blob; say so
      // rather than printing an empty bubble.
      if (block.redacted) return [{ cls: "think", text: "thinking (redacted by the provider)" }];
      return [{ cls: "think", text: `thinking: ${clip(String(block.thinking ?? ""))}` }];
    case "toolCall":
      return [
        { cls: "tool", text: `tool ${label(block.name, label(block.toolName, "?"))}` },
        { cls: "meta", text: fmt(block.arguments ?? block.args ?? block.input) },
      ];
    case "image":
      return [
        {
          cls: "meta",
          text: `image (${label(block.mimeType, "unknown type")}, ${String(block.data ?? "").length} base64 chars)`,
        },
      ];
    default:
      return [{ cls: "meta", text: `${label(block.type, "block")}: ${fmt(block)}` }];
  }
}

// The bridge emits BOTH shapes for one tool call: the legacy `tool_call` /
// `tool_result` pair and the newer `tool_execution_*` trio. They carry
// different field names for the same thing — `toolName` (not `name`),
// `input` (not `arguments`), `content` (an ARRAY of blocks, not `output`).
// Missing that is not cosmetic: the pre-fix client read `d.name` and
// `d.arguments`, so every legacy tool call drew as "[tool]  {}" — the tool's
// own name gone — and `String(d.output || d.text || "")` drew 240 recorded
// tool results as an empty bubble. See tools/render/old-textof.mjs.
/** A legacy `tool_result.content` array -> lines, using the same block reader. */
function contentLines(content, cls) {
  if (!Array.isArray(content)) return [{ cls, text: fmt(content) }];
  const out = [];
  for (const block of content) out.push(...blockLines(block).map((l) => ({ cls: l.cls === "text" ? cls : l.cls, text: l.text })));
  return out.length ? out : [{ cls: "meta", text: `content: (empty list of ${content.length})` }];
}

const TOOL_TYPES = new Set([
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_call",
  "tool_result",
]);
const VERB = {
  tool_execution_start: "▶",
  tool_execution_update: "…",
  tool_execution_end: "■",
  tool_call: "▶",
  tool_result: "■",
};

/**
 * One websocket event -> {role, title, lines}.
 * `role` drives the bubble colour; `title` is the one-line header.
 * EVERY event type the bridge emits is handled; an unrecognised one still
 * renders its whole payload rather than disappearing.
 */
export function describeEvent(event) {
  const data = (event && event.data) || {};
  // Dispatch on event.eventType, not data.type. The server only re-stamps
  // `data.type` on some paths (session-diff-source.ts, state-replay.ts): 36 of
  // 2076 events in the 2026-09-30 capture carry NO data.type at all, and every
  // one of those is a stats_update. Keying off data.type alone silently loses
  // them; the PoC's `event.eventType === "input"` was the right idea attached to
  // the wrong comparison.
  const type = String(event?.eventType || data.type || "event");

  if (type === "message_start" || type === "message_update" || type === "message_end") {
    const role = isPlain(data.message) ? data.message.role : undefined;
    return {
      role: role === "user" ? "user" : "assistant",
      title: role === "user" ? "you" : "assistant",
      lines: messageLines(data.message),
    };
  }

  if (TOOL_TYPES.has(type)) {
    const err = data.isError === true;
    return {
      role: "tool",
      title: `${VERB[type]} ${label(data.toolName, "tool")}${err ? " — failed" : ""}`,
      lines: [
        // `args` (new) and `input` (legacy) are the same field.
        ...(data.args !== undefined || data.input !== undefined
          ? [{ cls: "meta", text: `args: ${fmt(data.args !== undefined ? data.args : data.input)}` }]
          : []),
        // `result` (new, a string) and `content` (legacy, an ARRAY of blocks).
        ...(data.result !== undefined ? [{ cls: err ? "err" : "text", text: fmt(data.result) }] : []),
        ...(data.content !== undefined ? contentLines(data.content, err ? "err" : "text") : []),
        ...(data.partialResult !== undefined ? [{ cls: "text", text: fmt(data.partialResult) }] : []),
        ...(data.reason !== undefined ? [{ cls: "meta", text: `reason: ${fmt(data.reason)}` }] : []),
        ...(data.thresholdBytes !== undefined
          ? [{ cls: "meta", text: `server truncated this result at ${fmt(data.thresholdBytes)} bytes` }]
          : []),
        ...(data.details !== undefined ? [{ cls: "meta", text: `details: ${fmt(data.details)}` }] : []),
        ...(data.isError !== undefined && data.result === undefined && data.content === undefined
          ? [{ cls: "err", text: `isError: ${fmt(data.isError)}` }]
          : []),
      ],
    };
  }

  if (type === "stats_update") {
    const tu = data.turnUsage;
    const cu = data.contextUsage;
    return {
      role: "meta",
      title: "usage",
      lines: [
        { cls: "meta", text: `tokens in ${fmt(data.tokensIn)} · out ${fmt(data.tokensOut)} · cost ${fmt(data.cost)}` },
        ...(isPlain(tu)
          ? [{ cls: "meta", text: `turn: in ${fmt(tu.input)} · out ${fmt(tu.output)} · cacheRead ${fmt(tu.cacheRead)} · cacheWrite ${fmt(tu.cacheWrite)}` }]
          : []),
        ...(isPlain(cu)
          ? [{ cls: "meta", text: `context: ${fmt(cu.tokens)} of ${fmt(cu.contextWindow)}` }]
          : []),
      ],
    };
  }

  if (type === "model_select") {
    const m = data.model;
    return {
      role: "meta",
      title: "model",
      lines: [{ cls: "meta", text: isPlain(m) ? `${label(m.provider, "?")}/${label(m.id, "?")}` : fmt(m) }],
    };
  }

  if (type.startsWith("subagent_")) {
    // The lead-with-children view: a child agent is a first-class row.
    return {
      role: "child",
      title: `${type.replace("subagent_", "child ")}: ${label(data.name ?? data.agentId ?? data.id, "(unnamed)")}`,
      lines: [{ cls: "meta", text: fmt(stripEmpty(data, ["type", "name", "agentId", "id"])) }],
    };
  }

  if (type === "input") {
    return {
      role: "user",
      title: `input${data.streamingBehavior ? ` (${data.streamingBehavior})` : ""}`,
      lines: [{ cls: "text", text: fmt(stripEmpty(data, ["type", "streamingBehavior"])) }],
    };
  }

  if (type === "turn_end") {
    return {
      role: "meta",
      title: `turn ${fmt(data.turnIndex)} end`,
      lines: [
        ...(isPlain(data.contextUsage) ? [{ cls: "meta", text: `context: ${fmt(data.contextUsage.tokens)} of ${fmt(data.contextUsage.contextWindow)}` }] : []),
        ...(Array.isArray(data.toolResults)
          ? [{ cls: "meta", text: `tool results this turn: ${data.toolResults.length}` }]
          : []),
        { cls: "meta", text: fmt(stripEmpty(data, ["type", "turnIndex", "contextUsage", "toolResults", "message"])) },
        // Keep each line's OWN class: the message body is verbatim payload, and
        // re-labelling it `meta` would make the structural sweep police text an
        // agent typed.
        ...(data.message !== undefined ? messageLines(data.message) : []),
      ],
    };
  }

  if (type === "before_agent_start") {
    return {
      role: "meta",
      title: "agent starting",
      lines: [
        ...(data.prompt !== undefined ? [{ cls: "text", text: fmt(data.prompt) }] : []),
        { cls: "meta", text: fmt(stripEmpty(data, ["type", "prompt", "systemPrompt", "systemPromptOptions"])) },
        ...(data.systemPrompt !== undefined ? [{ cls: "think", text: `system prompt: ${clip(String(data.systemPrompt))}` }] : []),
        ...(data.systemPromptOptions !== undefined ? [{ cls: "meta", text: `system prompt options: ${fmt(data.systemPromptOptions)}` }] : []),
      ],
    };
  }

  if (type === "agent_end") {
    return {
      role: "meta",
      title: `agent ended${data.reason ? ` (${label(data.reason, "no reason given")})` : ""}`,
      lines: [
        ...(Array.isArray(data.messages) ? [{ cls: "meta", text: `${data.messages.length} messages in the final result` }] : []),
        { cls: "meta", text: fmt(stripEmpty(data, ["type", "reason", "messages", "eventType", "__truncated", "thresholdBytes"])) },
      ],
    };
  }

  if (type === "command_feedback") {
    return {
      role: "meta",
      title: `command: ${label(data.command, "(unknown)")}`,
      lines: [{ cls: "meta", text: fmt(stripEmpty(data, ["type", "command"])) }],
    };
  }

  if (type === "bash_output") {
    return {
      role: "tool",
      title: "bash",
      lines: [{ cls: "text", text: fmt(stripEmpty(data, ["type"])) }],
    };
  }

  // Everything else — agent_*, auto_retry_*, session_compact, custom_entry,
  // goal_*, and any type a future bridge adds — is printed in full. The
  // unknown-shape rule is the point: a new event must be READABLE on the day
  // it ships, not after someone opens a defect.
  return {
    role: "meta",
    title: type,
    lines: [{ cls: "meta", text: fmt(stripEmpty(data, ["type"])) }],
  };
}

function stripEmpty(obj, drop) {
  if (!isPlain(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (drop.includes(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : "(no further detail)";
}
