/**
 * axe `document-title` + `html-has-lang` (rc-suites client-JS matrix): every
 * HTML page the dashboard serves names its language and has a title. The
 * language is the app's i18n default ("en", packages/client/src/lib/i18n).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthPlugin } from "../auth/auth-plugin.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SERVED_FILES = [
  "packages/client/src/index.html", // the dashboard SPA shell
  "public/mobile/index.html",
  "public/links/index.html",
  "public/graph/index.html",
  "packages/electron/resources/loading.html",
];

function expectTitleAndLang(html: string, what: string) {
  expect(html, `${what}: <html lang>`).toMatch(/<html\b[^>]*\blang="[a-z]{2}(-[A-Za-z]+)?"/);
  expect(html, `${what}: non-empty <title>`).toMatch(/<title>[^<\s][^<]*<\/title>/);
}

describe("served HTML has <title> and <html lang>", () => {
  for (const f of SERVED_FILES) {
    it(f, () => expectTitleAndLang(fs.readFileSync(path.join(ROOT, f), "utf8"), f));
  }

  it("the server-rendered sign-in page", async () => {
    const app = Fastify();
    await registerAuthPlugin(app, {
      authConfig: { secret: "test-secret-32-chars-long-abcdef", providers: { github: { clientId: "c", clientSecret: "s" } } },
      port: 8000,
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/auth/login?error=x", remoteAddress: "203.0.113.5" });
    await app.close();
    expect(res.statusCode).toBe(200);
    expectTitleAndLang(res.body, "/auth/login");
  });
});
