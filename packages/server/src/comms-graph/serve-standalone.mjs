/**
 * Standalone prototype server for the /graph sub-app.
 *
 * WHY THIS EXISTS, and why it is a legitimate artefact rather than scaffolding:
 * the brief says prototype against a COPY of the session files, not the live
 * daemon, and the dashboard server is not reachable from a sandbox. So this
 * serves the SAME `public/graph/` files and the SAME `CommsGraphIndexer` on a
 * bare node http server, pointed at a corpus copy by `PRIME_AGENT_HOME`. The
 * only thing it does not do is run fastify, the guard and the auth - which is
 * precisely the part the deployed version inherits and this one must not
 * pretend to have.
 *
 * Run:
 *   PRIME_AGENT_HOME=<corpus dir> node --import tsx serve-standalone.mjs [port]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The repo is TypeScript and runs under tsx/jiti; the sandbox prototype has
// neither. Importing the `.ts` file by its real name lets plain `node
// --experimental-strip-types` run it, so the prototype needs no toolchain at
// all in the sandbox. Node resolves the explicit extension, and the type
// annotations are stripped.
import { CommsGraphIndexer } from "./indexer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// packages/server/src/comms-graph -> repo root
const repoRoot = path.resolve(here, "..", "..", "..", "..");
// GRAPH_PUBLIC_DIR lets the prototype run from a flat copy (a sandbox has no
// monorepo), and defaults to the repo layout when it is unset.
const publicDir = process.env.GRAPH_PUBLIC_DIR
  ? path.resolve(process.env.GRAPH_PUBLIC_DIR)
  : path.join(repoRoot, "public", "graph");

const primeDir = process.env.PRIME_AGENT_HOME;
if (!primeDir) {
  console.error("set PRIME_AGENT_HOME to a COPY of the session corpus (never the live one)");
  process.exit(2);
}
const port = Number(process.argv[2] || 8099);
// The dashboard server rate-limits scans to one a second, which is right when
// twenty browsers are watching and wrong for this prototype, where ONE client
// has to walk a 336 MB cold start to the end. PROTOTYPE_FAST=1 removes the
// floor; it is never the default, and it changes nothing about the indexer.
const minIntervalMs = process.env.PROTOTYPE_FAST === "1" ? 0 : 1000;
const indexer = new CommsGraphIndexer({ primeDir, minIntervalMs });

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/comms/graph") {
    await indexer.scan();
    const since = Number.parseInt(url.searchParams.get("since") ?? "", 10);
    const body = JSON.stringify(indexer.snapshot(Number.isFinite(since) ? { since } : {}));
    res.writeHead(200, { "content-type": TYPES[".json"], "cache-control": "no-store" });
    res.end(body);
    return;
  }
  const rel = url.pathname.replace(/^\/graph\/?/, "") || "index.html";
  const file = path.join(publicDir, rel);
  // never serve outside public/graph
  if (!file.startsWith(publicDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(file));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`graph prototype on http://0.0.0.0:${port}/graph/  corpus=${primeDir}`);
});
