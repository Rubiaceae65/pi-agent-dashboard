/**
 * mobile-render.spec.ts — the phone client must render the dashboard's real
 * payloads READABLY.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The owner's report, 2026-09-30: "Mobile poc shows [object] — was that even
 * tested?" It was not. The guard lead had measured `/mobile/` as
 * `200 1649 B <title>pi mobile</title>` and stopped there: the HTML was served,
 * so the page was declared working. Nobody ever rendered it with data, and the
 * client's one text formatter,
 *
 *     if (d.message) return String(d.message);
 *
 * draws "[object Object]" for 87.3% of real events, because `data.message` is
 * the pi message OBJECT whose `content` is an ARRAY of blocks.
 *
 * WHAT IT ASSERTS
 * ---------------
 * Against a real HTTP + WebSocket server fed by fixtures RECORDED OFF THE LIVE
 * DASHBOARD (see fixtures/README.md), at a phone viewport:
 *
 *   1. no console error and no uncaught page error on any view;
 *   2. no "[object …]" and no bare `undefined` / `NaN` in what is rendered;
 *   3. specific data that the payload really contains is VISIBLE — the test
 *      fails on an empty screen that merely avoids the banned strings, which is
 *      the failure mode a grep-only assertion always has;
 *   4. a payload shape the client has never seen still renders its keys.
 *
 * The banned-string check is PROVENANCE-BASED, not a grep. A real stream
 * contains arbitrary agent text, including sentences about "[object Object]"
 * itself; flagging those would be the test lying. A banned token is a failure
 * only when it is not a substring (or clipped prefix) of any string in the
 * event that produced it. See the identical check in tools/render/old-sweep.mjs,
 * which reports 7207 invented tokens against the pre-fix formatter.
 */
import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

/**
 * Session ids we have a recorded stream for, read from the CONTENT of each
 * capture rather than from its filename: a capture is named after the session
 * it came from, and a name is a weaker claim than the `sessionId` the server
 * stamped on the frames.
 */
const streamIds: string[] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".jsonl") && !f.startsWith("synthetic-"))
  .map((f) => JSON.parse(readFileSync(join(FIXTURES, f), "utf8").split("\n").find((l) => l.trim())!).sessionId);

const streamFile = (id: string) =>
  readdirSync(FIXTURES).find((f) => {
    if (!f.endsWith(".jsonl") || f.startsWith("synthetic-")) return false;
    return JSON.parse(readFileSync(join(FIXTURES, f), "utf8").split("\n").find((l) => l.trim())!).sessionId === id;
  })!;

/** The name a session is listed under, straight from the recorded payload. */
const sessionNameFor = (id: string): string => {
  const sessions = JSON.parse(readFileSync(join(FIXTURES, "sessions.json"), "utf8")).data as {
    id: string;
    name?: string;
    cwd?: string;
  }[];
  const s = sessions.find((x) => x.id === id);
  if (!s) throw new Error(`no recorded session row for ${id}`);
  return s.name ?? s.cwd?.split("/").filter(Boolean).pop() ?? id;
};

const eventsOf = (id: string) =>
  readFileSync(join(FIXTURES, streamFile(id)), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => JSON.parse(l).events || []);

/** Every string that appears anywhere inside an event — the provenance set. */
function stringsOf(v: string, out: string[] = []): string[] {
  const walk = (x: unknown): void => {
    if (typeof x === "string") out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(JSON.parse(v));
  return out;
}

const BANNED = [/\[object [^\]]*\]/g, /(^|[\s:,(])(undefined|NaN)(?=[\s,).:]|$)/g];

let server: ChildProcess;
let baseURL: string;

test.beforeAll(async () => {
  server = spawn(process.execPath, [join(HERE, "fixture-server.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture server did not report a port in 20s")), 20_000);
    server.stdout!.on("data", (chunk: Buffer) => {
      const m = /^PORT (\d+)/m.exec(String(chunk));
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  baseURL = `http://127.0.0.1:${port}`;
});

test.afterAll(() => {
  server?.kill();
});

/** Open a session and wait for its recorded events to finish drawing. */
async function openSession(page: import("@playwright/test").Page, id: string) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${baseURL}/mobile/`, { waitUntil: "domcontentloaded" });
  await page.locator("#list .row").first().waitFor({ timeout: 15_000 });
  // Select the row the way a PERSON would: by the session's name. Deliberately
  // NOT by `data-session-id` — that attribute is part of the fix, so leaning on
  // it would make this test fail on d49e9954a for the wrong reason (a missing
  // selector) instead of the right one (unreadable rendering). The pre-fix
  // client draws `s.title || s.name || s.id`, so a name matches on both sides.
  const name = sessionNameFor(id);
  await page
    .locator("#list .row")
    .filter({ hasText: name })
    .first()
    .click({ timeout: 20_000 });
  await expect(page.locator("#log .msg").first()).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(async () => page.locator("#log .msg").count(), { timeout: 20_000 })
    .toBeGreaterThan(5);
  return errors;
}

const shortId = (id: string) => id.slice(0, 8);

test.describe("phone client /mobile/", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("the session list renders every row with real data and no empty list", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${baseURL}/mobile/`, { waitUntil: "domcontentloaded" });
    const rows = page.locator("#list .row");
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);
    // An empty list is a failure even with zero banned strings: the recorded
    // payload HAS sessions, so an empty list means the client dropped them.
    await expect(page.locator("#list .empty")).toHaveCount(0);
    // A row must carry a name and a cwd from the payload, not a raw UUID.
    const first = await rows.first().innerText();
    expect(first).not.toMatch(/^[0-9a-f-]{36}$/m);
    expect(first).toContain("/projects/");
    expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([]);
  });

  for (const id of streamIds) {
    test(`session ${shortId(id)}: every recorded event renders readably`, async ({ page }) => {
      const errors = await openSession(page, id);
      const messages = page.locator("#log .msg");
      const count = await messages.count();
      expect(count, "the log drew no messages at all").toBeGreaterThan(5);

      // The ban, applied with provenance.
      const rendered = await page.evaluate(() =>
        [...document.querySelectorAll("#log .msg")].map((m) => ({
          who: m.querySelector(".who")?.textContent ?? "",
          text: m.textContent ?? "",
        })),
      );
      const offenders: string[] = [];
      for (const line of rendered) {
        for (const re of BANNED) {
          for (const m of line.text.matchAll(re)) {
            const tok = m[0].trim();
            const stem = tok.replace(/… \[\d+ chars total\]$/, "");
            if (stringsOf(JSON.stringify(eventsOf(id))).some((s) => s.includes(tok) || s.includes(stem) || s.startsWith(stem))) {
              continue; // the payload said it; we are not the renderer that made it
            }
            offenders.push(`${shortId(id)}: "${tok}" in ${line.who}`);
          }
        }
      }
      expect(offenders, `renderer invented ${offenders.length} value(s):\n${offenders.join("\n")}`).toEqual([]);
      expect(errors, `console/page errors: ${errors.join(" | ")}`).toEqual([]);
    });
  }

  test("real payload data is VISIBLE, not merely free of banned strings", async ({ page }) => {
    // The strongest anti-green-check assertion here: a page that rendered
    // nothing at all would pass a pure "no [object" grep. These are strings
    // that are provably present in the recorded fixtures, and the client's only
    // transformation is clipping past 400 chars — so a 60-char head of a
    // recorded text block must appear on screen verbatim.
    const id = streamIds[0];
    const events = eventsOf(id);
    const toolNames = [
      ...new Set(
        events
          .filter((e) => e.event.data.toolName)
          .map((e) => String(e.event.data.toolName)),
      ),
    ];
    const textBlocks = [
      ...new Set(
        events.flatMap((e) =>
          (Array.isArray(e.event.data.message?.content) ? e.event.data.message.content : [])
            .filter((c: { type?: string; text?: unknown }) => c?.type === "text" && typeof c.text === "string")
            .map((c: { text: string }) => c.text),
        ),
      ),
    ]
      .map((s) => s.split("\n")[0].trim())
      .filter((s) => s.length >= 25);
    expect(toolNames.length + textBlocks.length, "fixture has no quotable data").toBeGreaterThan(3);

    await openSession(page, id);
    const body = await page.locator("#log").innerText();
    const seenTools = toolNames.filter((n) => body.includes(n));
    const seenText = textBlocks.filter((s) => body.includes(s.slice(0, 60)));
    expect(
      seenTools.length + seenText.length,
      `none of ${toolNames.length} tool names / ${textBlocks.length} recorded text heads reached the screen`,
    ).toBeGreaterThan(0);
    // And the header must be a display name, not a 36-char UUID.
    await expect(page.locator("#dtitle")).not.toHaveText(/^[0-9a-f-]{36}$/);
  });

  test("a payload shape the client has never seen still renders its keys", async ({ page }) => {
    // The forward-compatibility case. `synthetic-unknown-shape.jsonl` holds a
    // REAL recorded stats_update with its type renamed and a nested object
    // grafted on — the shape a future bridge could ship tomorrow. The client
    // must print the keys readably rather than fall through to String().
    const id = readFileSync(join(FIXTURES, "synthetic-unknown-shape.jsonl"), "utf8")
      .split("\n")
      .find((l) => l.trim())!;
    const replay = JSON.parse(id);
    const frame = replay.events[0];
    await openSession(page, replay.sessionId);
    const bubble = page.locator("#log .msg").filter({ hasText: frame.event.eventType }).last();
    await expect(bubble).toBeVisible();
    const body = await bubble.innerText();
    expect(body).toContain(frame.event.eventType);
    expect(body).toContain("goal");
    expect(body).toContain("budget");
    // Scoped to THIS bubble, not the whole log: a real transcript can contain
    // an agent's own sentence about "[object Object]", and policing that would
    // be the test lying about the renderer.
    expect(body).not.toContain("[object");
  });
});
