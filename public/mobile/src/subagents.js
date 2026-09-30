/**
 * pi-mobile — rlm sub-agent nesting.
 *
 * Same rule as the desktop list (`packages/client/src/lib/session/session-subagents.ts`),
 * reimplemented in plain ES module JS because this client is served as static
 * files with no build step. Kept in its own file so the change to
 * `app.js` stays to one import and one call.
 *
 * Why the phone needs it too: a sub-agent is an in-process sub-session of its
 * lead's worker, so it appears in `/api/sessions` as an ordinary row with a
 * `parentSessionId`. Rendered flat, a child reads as a second lead — on a
 * phone, where the folder grouping that separates them does not exist, that
 * is even more misleading than on the desktop.
 *
 * See change: surface-rlm-subagent-children.
 */

import { fmt, label, sessionName } from './format.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/** True when a row is an rlm sub-agent, by the server's own marker. */
export function isRlmChild(session) {
  return typeof session.parentSessionId === 'string' && session.parentSessionId.length > 0;
}

/** parentId -> its direct children, in the order they were given. */
export function indexChildrenByParent(sessions) {
  const index = new Map();
  for (const s of sessions) {
    if (!isRlmChild(s)) continue;
    const list = index.get(s.parentSessionId);
    if (list) list.push(s);
    else index.set(s.parentSessionId, [s]);
  }
  return index;
}

/**
 * Rows that are NOT sub-agents, and where the rest should be drawn.
 *
 * A row that names a parent IS a child, whether or not that parent is in the
 * list. Deriving this by walking the tree is equivalent on a well-formed
 * listing and wrong on a malformed one: a row whose `parentSessionId` is its
 * own id is its own ancestor, so no downward walk from any top-level row
 * reaches it and it would surface as a peer.
 */
export function topLevelRows(sessions) {
  return sessions.filter((s) => !isRlmChild(s));
}

/**
 * The rows to draw, in order, each with its indentation depth.
 *
 * `depth: 0` is a lead. A child sits directly under its own parent's card
 * within the flat list, so the indentation is the number of ancestors between
 * it and the lead — which is what the CSS left-border steps on.
 *
 * A child whose parent is absent (filtered, or a lead this poll did not
 * return) is drawn FLAT at depth 0 rather than dropped. It is real work, and
 * losing it because the parent's row scrolled out of the list would be a
 * silent loss. The walk is guarded, so a cycle in the parent links cannot
 * hang the phone.
 */
export function flattenWithChildren(sessions) {
  const index = indexChildrenByParent(sessions);
  const out = [];
  const seen = new Set();

  const walk = (id, depth) => {
    for (const child of index.get(id) || []) {
      if (seen.has(child.id)) continue; // cycle guard
      seen.add(child.id);
      out.push({ session: child, depth });
      walk(child.id, depth + 1);
    }
  };

  for (const s of topLevelRows(sessions)) {
    out.push({ session: s, depth: 0 });
    walk(s.id, 1);
  }
  // Anything the walk never reached, including every member of a cycle.
  for (const s of sessions) {
    if (isRlmChild(s) && !seen.has(s.id)) out.push({ session: s, depth: 0 });
  }
  return out;
}

/**
 * One list row. A sub-agent row carries `data-subagent-of` (its IMMEDIATE
 * parent), `data-subagent-depth`, and a `depth` class, so the tree is
 * readable from the DOM and not only from the indentation.
 */
export function buildRow(s, depth, onOpen) {
  const b = el('button', 'row' + (depth > 0 ? ' subagent d' + Math.min(depth, 4) : ''));
  b.dataset.sessionId = label(s.id, '');      // stable hook for the render test
  if (depth > 0) {
    b.dataset.subagentOf = s.parentSessionId;
    b.dataset.subagentDepth = String(depth);
  }
  // NEVER draw a raw field. This is the guarantee that used to live in
  // app.js's renderList(), which no longer builds rows at all now that
  // nesting owns it: `s.cwd` is whatever the server sent, and
  // `[s.cwd].join(' ')` on an object is the "[object Object]" this client
  // exists to stop drawing. label() cannot return one.
  const name = sessionName(s);
  b.appendChild(el('span', 't', (depth > 0 ? '\u21b3 ' : '') + name));
  const bits = [label(s.cwd, ''), label(s.status, ''), label(s.model, '')].filter(Boolean).join(' \u00b7 ');
  const m = el('span', 'm', bits || label(s.id, ''));
  if (depth > 0 && s.rlmDepth) m.textContent = `sub-agent \u00b7 depth ${fmt(s.rlmDepth)} \u00b7 ` + m.textContent;
  if (typeof s.tokensIn === 'number' || typeof s.contextTokens === 'number') {
    b.appendChild(el('span', 'k', `ctx ${fmt(s.contextTokens)} \u00b7 in ${fmt(s.tokensIn)}`));
  }
  b.onclick = () => onOpen(s.id, name);
  return b;
}
