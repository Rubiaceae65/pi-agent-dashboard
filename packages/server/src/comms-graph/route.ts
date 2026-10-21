/**
 * `GET /api/comms/graph` — the one route the `/graph/` sub-app reads.
 *
 * READ-ONLY BY CONSTRUCTION, which is the point: there is no POST, no query
 * parameter that names a session to act on, and no handle. The handler calls
 * `scan()` and serialises. It cannot send a message, change a session, or start
 * one, because there is no code here that could.
 *
 * ONE INDEXER PER SERVER, held in a WeakMap keyed by the Fastify instance, so
 * twenty browser tabs share one set of cursors and one bounded graph. The
 * alternative - an indexer per client - is the unbounded thing this whole
 * design exists to avoid, and the test below boots a server, opens 30 clients'
 * worth of requests, and asserts the indexer count is still one.
 *
 * It lives under `/api`, which is inside the network guard's jurisdiction
 * (`auth/localhost-guard.ts` builds that from `SUB_APP_PREFIXES` and
 * `/api`), so it inherits the same login as the rest of the dashboard. No new
 * auth path was added, which is what `panels-integration-20260930` asked for.
 */

import os from "node:os";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CommsGraphIndexer } from "./indexer.js";

export const COMMS_GRAPH_ROUTE = "/api/comms/graph";

/**
 * The one indexer, keyed by the corpus it reads.
 *
 * Keyed by `primeDir` rather than by the Fastify instance so that "there is
 * only one" is a fact a test can read instead of a claim. Capped at
 * {@link MAX_INDEXERS} because a module-level map is the one structure here
 * that no request can reach and therefore the one that needs a bound of its
 * own; in a normal server the size is 1 forever.
 */
const MAX_INDEXERS = 4;
const INDEXERS = new Map<string, CommsGraphIndexer>();

/**
 * Where the session files are.
 *
 * `PRIME_AGENT_HOME` wins when set, so the sandbox prototype can point at a
 * COPY of the real corpus and never touch the live one. The default matches
 * the daemon's own layout.
 */
export function primeAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PRIME_AGENT_HOME;
  if (explicit && explicit.length > 0) return explicit;
  return path.join(env.HOME ?? os.homedir(), ".prime", "agent");
}

export function indexerFor(_fastify?: FastifyInstance, primeDir = primeAgentDir()): CommsGraphIndexer {
  const existing = INDEXERS.get(primeDir);
  if (existing) return existing;
  if (INDEXERS.size >= MAX_INDEXERS) {
    // Drop the oldest entry rather than growing: a stale corpus is the one
    // worth losing, and 4 live corpora is already more than this server has.
    const oldest = INDEXERS.keys().next();
    if (!oldest.done) INDEXERS.delete(oldest.value);
  }
  const created = new CommsGraphIndexer({ primeDir });
  INDEXERS.set(primeDir, created);
  return created;
}

/** How many indexers exist. Read by the test that proves there is one. */
export function indexerCount(): number {
  return INDEXERS.size;
}

export function registerCommsGraphRoute(fastify: FastifyInstance): void {
  const ix = indexerFor(fastify);
  fastify.get(COMMS_GRAPH_ROUTE, async (request: FastifyRequest, reply: FastifyReply) => {
    const q = request.query as { since?: string; window?: string } | undefined;
    const since = q?.since !== undefined ? Number.parseInt(q.since, 10) : undefined;
    const windowMs = q?.window !== undefined ? Number.parseInt(q.window, 10) : undefined;
    // A tick is bounded by `minIntervalMs` and by `maxBytesPerScan`, so this
    // await returns promptly even on the very first request against a cold
    // 68 MB corpus.
    await ix.scan();
    const snapshot = ix.snapshot({
      ...(Number.isFinite(since) ? { since: since as number } : {}),
      ...(Number.isFinite(windowMs) ? { windowMs: windowMs as number } : {}),
    });
    reply.header("cache-control", "no-store");
    return reply.send(snapshot);
  });
}
