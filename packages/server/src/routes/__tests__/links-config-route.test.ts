/**
 * `/links/` data comes from the deployment (`PI_DASHBOARD_LINKS_FILE`), never
 * from a baked inventory (rc-suites RC 0011: plain-http IP links → mixed
 * content behind the door; release rule R3.4 own DNS only, no IPs).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { LINKS_DATA_ROUTE, loadLinks, registerLinksConfigRoute, safeLinkUrl } from "../links-config-route.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function writeFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "links-"));
  tmp.push(dir);
  const f = path.join(dir, "links.json");
  fs.writeFileSync(f, content);
  return f;
}

async function get(file: string | undefined) {
  const app = Fastify();
  registerLinksConfigRoute(app, () => file);
  await app.ready();
  const res = await app.inject({ method: "GET", url: LINKS_DATA_ROUTE });
  await app.close();
  return res;
}

describe("GET /links/links.json", () => {
  it("unset: not configured, empty — no fallback inventory", async () => {
    const res = await get(undefined);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ configured: false, links: [], dropped: 0 });
  });

  it("configured file: the deployment's links are served", async () => {
    const f = writeFile(
      JSON.stringify({
        links: [
          { label: "Dashboard", url: "https://dash.door.example.org/", group: "Door" },
          { label: "Mobile", url: "https://ops.door.example.org/mobile/", note: "phone client" },
        ],
      }),
    );
    expect((await get(f)).json()).toEqual({
      configured: true,
      dropped: 0,
      links: [
        { label: "Dashboard", url: "https://dash.door.example.org/", group: "Door" },
        { label: "Mobile", url: "https://ops.door.example.org/mobile/", note: "phone client" },
      ],
    });
  });

  it("bad entries are dropped and counted; good ones kept", async () => {
    const f = writeFile(
      JSON.stringify([
        { label: "ok", url: "https://ha.door.example.org" },
        { label: "plain http", url: "http://ha.door.example.org/" },
        { label: "ip", url: "https://100.65.131.102:8000/" },
        { label: "ipv6", url: "https://[::1]/" },
        { label: "js", url: "javascript:alert(1)" },
        { label: "data", url: "data:text/html,<script>alert(1)</script>" },
        { label: "creds", url: "https://u:p@shop.example.org/" },
        { url: "https://nolabel.example.org/" },
        { label: "<img src=x onerror=alert(1)>", url: "https://portal.door.example.org/" },
        "not an object",
        null,
      ]),
    );
    const body = (await get(f)).json();
    expect(body.configured).toBe(true);
    expect(body.dropped).toBe(9);
    // Labels are data: returned verbatim, the page renders them with textContent.
    expect(body.links).toEqual([
      { label: "ok", url: "https://ha.door.example.org/" },
      { label: "<img src=x onerror=alert(1)>", url: "https://portal.door.example.org/" },
    ]);
  });

  it("missing / malformed file: configured but unusable, no links, no path leaked", async () => {
    const missing = (await get("/nonexistent/links.json")).json();
    expect(missing).toEqual({ configured: true, links: [], dropped: 0, error: "unreadable" });
    expect(JSON.stringify(missing)).not.toContain("nonexistent");
    expect(loadLinks(writeFile("{not json"))).toEqual({ configured: true, links: [], dropped: 0, error: "invalid" });
    expect(loadLinks(writeFile('{"hosts":{}}'))).toMatchObject({ error: "invalid" });
  });

  it("safeLinkUrl: https + DNS host only", () => {
    expect(safeLinkUrl("https://odoo.door.example.org/odoo")).toBe("https://odoo.door.example.org/odoo");
    for (const bad of ["http://x.example.org/", "ftp://x.example.org/", "https://10.99.227.30/", "//x.example.org", ""]) {
      expect(safeLinkUrl(bad), bad).toBeNull();
    }
  });
});

describe("the documented example (docker/links.example.json)", () => {
  it("validates completely: every venue link kept, nothing dropped", () => {
    const f = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../docker/links.example.json");
    const r = loadLinks(f);
    expect(r).toMatchObject({ configured: true, dropped: 0 });
    expect(r.links).toHaveLength(8);
  });
});

describe("the shipped page carries no inventory", () => {
  const PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../public/links/index.html");
  const html = fs.readFileSync(PAGE, "utf8");

  it("has no IP literal and no plain-http URL", () => {
    expect(html).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(html).not.toContain("http://");
  });

  it("reads the deployment's links and renders config as text, never innerHTML", () => {
    expect(html).toContain("./links.json");
    expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(html).toContain("not configured");
  });
});
