/**
 * `GET /links/links.json` — the data the `/links/` page renders.
 *
 * The links are the DEPLOYMENT's, not the page's. The page used to ship a
 * baked inventory (one dev system's tailnet + LAN IPs over plain http); behind
 * a TLS front door that is mixed content the browser blocks, it bypasses the
 * door, and release rule R3.4 (own DNS only, no IPs) forbids it. Now the
 * deployment names a JSON file in `PI_DASHBOARD_LINKS_FILE`; unset, the page
 * shows an empty "not configured" state — there is no built-in fallback.
 *
 * The route lives UNDER the sub-app prefix on purpose: a front door that
 * routes only `/links/` to the dashboard (ops.door) reaches it, where an
 * `/api/...` route would 404. It is in the network guard's jurisdiction like
 * the page itself (`SUB_APP_PREFIXES`).
 *
 * File format (UTF-8 JSON, ≤ 256 KiB):
 *
 *   { "links": [ { "label": "Dashboard", "url": "https://dash.door.example.org/",
 *                  "group": "Front door", "note": "optional text" } ] }
 *
 * (a bare array of entries is accepted too). Every entry is validated; an
 * invalid one is DROPPED and counted, never passed through: `url` must parse,
 * be `https:`, carry no credentials and name a DNS host (no IP literal);
 * `label` is required. Strings are returned as data — the page renders them as
 * text, never as HTML.
 */
import fs from "node:fs";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import { LINKS_PREFIX } from "../lib/static-subapps.js";

export const LINKS_FILE_ENV = "PI_DASHBOARD_LINKS_FILE";
export const LINKS_DATA_ROUTE = `${LINKS_PREFIX}/links.json`;

const MAX_FILE_BYTES = 256 * 1024;
const MAX_LINKS = 200;
const MAX_LABEL = 120;
const MAX_GROUP = 80;
const MAX_NOTE = 400;

export interface LinkEntry {
  label: string;
  url: string;
  group?: string;
  note?: string;
}

export interface LinksPayload {
  /** False when `PI_DASHBOARD_LINKS_FILE` is unset/empty. */
  configured: boolean;
  links: LinkEntry[];
  /** Entries present in the file but refused by validation. */
  dropped: number;
  /** Set when configured but the file could not be used. Never the path. */
  error?: "unreadable" | "invalid";
}

function optionalText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, max) : undefined;
}

/** A safe link URL: https, no credentials, a DNS hostname (not an IP literal). */
export function safeLinkUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || net.isIP(host) !== 0) return null;
  return u.href;
}

/** Validate one entry; null when it must be dropped. */
export function validateLinkEntry(raw: unknown): LinkEntry | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const label = optionalText(r.label, MAX_LABEL);
  const url = safeLinkUrl(r.url);
  if (!label || !url) return null;
  const entry: LinkEntry = { label, url };
  const group = optionalText(r.group, MAX_GROUP);
  const note = optionalText(r.note, MAX_NOTE);
  if (group) entry.group = group;
  if (note) entry.note = note;
  return entry;
}

/** Read + validate the deployment's links file. Never throws. */
export function loadLinks(file: string | undefined): LinksPayload {
  const path = file?.trim();
  if (!path) return { configured: false, links: [], dropped: 0 };
  let text: string;
  try {
    if (fs.statSync(path).size > MAX_FILE_BYTES) return { configured: true, links: [], dropped: 0, error: "invalid" };
    text = fs.readFileSync(path, "utf8");
  } catch {
    return { configured: true, links: [], dropped: 0, error: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { configured: true, links: [], dropped: 0, error: "invalid" };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { links?: unknown }).links)
      ? (parsed as { links: unknown[] }).links
      : null;
  if (!list) return { configured: true, links: [], dropped: 0, error: "invalid" };
  const links: LinkEntry[] = [];
  let dropped = 0;
  for (const raw of list) {
    const entry = links.length < MAX_LINKS ? validateLinkEntry(raw) : null;
    if (entry) links.push(entry);
    else dropped += 1;
  }
  return { configured: true, links, dropped };
}

/**
 * Register the read-only links data route. MUST be called before
 * `fastify-static` (explicit route wins). The file is re-read per request so
 * a ConfigMap update needs no restart; it is small and bounded.
 */
export function registerLinksConfigRoute(
  fastify: FastifyInstance,
  getFile: () => string | undefined = () => process.env[LINKS_FILE_ENV],
): void {
  fastify.get(LINKS_DATA_ROUTE, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return reply.send(loadLinks(getFile()));
  });
}
