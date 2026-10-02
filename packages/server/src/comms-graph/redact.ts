/**
 * Redaction for the comms graph.
 *
 * The graph shows a message's FIRST LINE, which sounds like enough care on its
 * own and is not. A first line is still an agent's first line, and agents put
 * things in first lines: `/projects/<lead>/secrets/mail_system_token`, a token
 * pasted to settle an argument, a tailnet address, a bearer header. The
 * constraint in the job brief is "never secrets, scrub the way the dashboard
 * does", and the honest reading is that no existing scrubber covers free prose
 * from a model, so this is a dedicated layer with its own tests.
 *
 * WHAT IT DOES, in order:
 *   1. drop control characters and ANSI escapes (they corrupt the canvas label);
 *   2. replace anything that LOOKS like a credential, by shape, with a marker;
 *   3. cap the length.
 *
 * A note on coverage, because the file's own prose was once wider than its
 * rules: the scheme rule catches `Bearer`/`Basic`/`Digest`/`Token` wherever
 * they appear - bare, colon-separated, lower case, in prose, inside a `curl` -
 * and NOT only after the literal word `authorization:`. Seven phrasings leaked
 * through that gap until a verifier planted a token of their own; those seven
 * are now tests.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: guess. There is no "looks like an
 * internal address, hide it" rule, because a graph of a workshop that hid its
 * own addresses would be a graph nobody could act on. Addresses and paths are
 * left alone; CREDENTIALS are not. A pattern that matches nothing costs one
 * regex over a 200-character line.
 */

/** Replace a match with a marker that says WHAT was removed, not how much. */
const MARK = "[redacted]";

/**
 * Shape-based credential patterns.
 *
 * Each entry is [name, regex]. They are all anchored on a shape no ordinary
 * sentence has, so the false-positive rate on a real first line is low enough
 * that a lead can still read its own graph.
 */
const PATTERNS: [string, RegExp, (m: string, ...g: string[]) => string][] = [
  // PEM blocks, however truncated to a first line. The header is the useful
  // half; the body is the secret.
  [
    "private key",
    // The body is base64 and has no spaces, so `\S+` is both correct and
    // bounded; `.*` would eat the rest of the first line with it.
    /(-----BEGIN [A-Z ]*PRIVATE KEY-----\s*)\S+/g,
    (_m, head: string) => `${head.trimEnd()} ${MARK}`,
  ],
  // Provider keys, with and without the provider prefix.
  ["api key", /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, () => MARK],
  ["api key", /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, () => MARK],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, () => MARK],
  ["google key", /\bAIza[0-9A-Za-z_-]{20,}\b/g, () => MARK],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, () => MARK],
  // A bearer header. "Authorization:" is kept: WHICH header is not a secret,
  // and a graph line that says "Authorization: [redacted]" is actionable.
  [
    "authorization header",
    /\b(authorization\s*:\s*)(?:bearer|basic|token)?\s*\S+/gi,
    (_m, head: string) => `${head}${MARK}`,
  ],
  // A credential announced by its SCHEME, wherever the scheme appears.
  //
  // The rule above is anchored on the literal word `authorization:`, so it only
  // ever caught the header form. A verifier token of their own devising
  // (`Zqv7alphaBRAVO9912secret`, which appears nowhere in this branch) walked
  // through in full in six other shapes - bare `Bearer <t>`, `Bearer: <t>`,
  // lower case, trailing dot, in prose, and inside `curl -H Bearer <t>`. That is
  // the whole point of the feature: `curl -H 'Bearer <token>'` is how a
  // credential reaches a lead's report, and this graph renders first lines to
  // whoever is logged in.
  //
  // The scheme word is KEPT (`Bearer [redacted]`), because which scheme it was is
  // exactly what makes the line actionable.
  //
  // And the candidate must LOOK like a credential, or this rule eats ordinary
  // English: `bearer tokens live in the vault` is prose. Length plus a digit, or
  // length plus mixed case, is what separates a token from a noun.
  [
    "bearer-style credential",
    /\b(bearer|basic|digest|token)(\s*[:=]\s*|\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
    (_m, scheme: string, sep: string, candidate: string) =>
      looksLikeCredential(candidate) ? `${scheme}${sep}${MARK}` : `${scheme}${sep}${candidate}`,
  ],
  // An explicit assignment whose NAME says it is a secret. This is the one that
  // catches the common case: "token: hunter2", "API_KEY=abc123". The name and
  // the separator survive; the value does not.
  [
    "assigned secret",
    /\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|credential)[A-Za-z0-9_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (_m, name: string, sep: string) => `${name}${sep}${MARK}`,
  ],
  // A URL with inline credentials: the scheme survives, the userinfo does not.
  [
    "url credentials",
    /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    (_m, scheme: string) => `${scheme}${MARK}@`,
  ],
  // The workshop's own secret store: the path is public knowledge, the file
  // name in it is a capability.
  [
    "secret store path",
    /(\/run\/user\/\d+\/atelier-secrets\/)\S+/g,
    (_m, dir: string) => `${dir}${MARK}`,
  ],
  // A long opaque blob on its own.
  ["opaque token", /\b[A-Za-z0-9_-]{48,}\b/g, () => MARK],
];

/**
 * Does this run of characters look like a credential rather than a word?
 *
 * The gap between the two rules that use it: `bearer tokens live in the vault`
 * must survive untouched, `bearer Zqv7alphaBRAVO9912secret` must not. A digit
 * anywhere is decisive (real tokens are full of them); failing that, mixed case
 * at length is. Both are cheap, both are bounded, and both err towards keeping
 * the line readable rather than towards redacting a noun.
 */
function looksLikeCredential(candidate: string): boolean {
  // The caller's regex already demands {12,}, so a length guard here would be
  // unreachable - a mutation test proved it: flipping it changed nothing.
  if (/\d/.test(candidate)) return true;
  return /[a-z]/.test(candidate) && /[A-Z]/.test(candidate);
}

/** Strip C0/C1 control characters and ANSI CSI sequences. */
function stripControl(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the job
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
}

/**
 * Redact one first line. Idempotent: redacting a redacted line changes nothing,
 * which is what lets the client render a line that came from anywhere.
 */
export function redact(line: string, max = 200): string {
  let out = stripControl(String(line ?? ""));
  for (const [, re, to] of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, to as (substring: string, ...args: unknown[]) => string);
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}\u2026` : out;
}

/** The names of the patterns, so a test can assert WHICH rule fired. */
export function whichRule(line: string): string | null {
  const flat = stripControl(String(line ?? ""));
  for (const [name, re] of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(flat)) return name;
  }
  return null;
}
