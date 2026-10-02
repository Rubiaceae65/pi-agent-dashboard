/**
 * The comms graph indexer - bounded, incremental, and singleton.
 *
 * WHAT THIS IS NOT. It is not a second session store. The dashboard already has
 * one; this reads the SAME files (`~/.prime/agent/sessions`, the rlm ledger, and
 * the rlm children's own transcripts under `session-artifacts`) with its own
 * cursors, because the graph needs a fact the session store does not carry at
 * all: which sessions sent which messages to which, when. There is nothing to
 * join against, so there was nothing to reuse.
 *
 * WHY PULL AND NOT PUSH. `scan()` is called from the request handler, not from
 * a timer, and `minIntervalMs` puts a floor under it. A dashboard with nobody
 * looking at the graph reads zero bytes; a dashboard with twenty clients
 * polling once a second still does one scan a second, not twenty. That is the
 * whole per-client memory argument: there is no per-client buffer to leak,
 * because there is no per-client anything.
 *
 * THE CAPS. Every structure here is bounded, and every bound is a constructor
 * option so a test can shrink it: maxNodes, maxEdges, perEdgeLines, maxRecent,
 * maxFiles, maxBytesPerScan.
 *
 * A full `~/.prime/agent/sessions` on this Brain is 156 files / 68 MB and a
 * complete re-parse costs 0.59 s in Python; a cold start therefore returns a
 * PARTIAL graph after one budgeted read and fills in over the following ticks.
 * That is the design, not an excuse: the page is useful with 20 sessions and
 * correct with 156 a few seconds later.
 */
import type fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { type Endpoint, extractLine, firstLine, type LineFact, resolveEndpoints } from "./extract.js";
import { redact } from "./redact.js";

export interface IndexerOptions {
  /** `~/.prime/agent` - the directory holding `sessions/`, `rlm-ledger/`, `session-artifacts/`. */
  primeDir: string;
  maxNodes?: number;
  maxEdges?: number;
  maxRecent?: number;
  perEdgeLines?: number;
  maxFiles?: number;
  maxBytesPerScan?: number;
  /** Floor between two scans, whatever the clients do. Default 1000 ms. */
  minIntervalMs?: number;
  now?: () => number;
}

export interface GraphNode {
  key: string;
  id: string | null;
  name: string;
  kind: "lead" | "child" | "external";
  parent: string | null;
  depth: number;
  model: string | null;
  state: string | null;
  goalStatus: string | null;
  contextPct: number | null;
  cwd: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  gone: boolean;
  relayFiredAt: string | null;
  messagesIn: number;
  messagesOut: number;
  spawnChildren: number;
  spawnedChildrenGone: number;
}

export interface GraphEdgeLine {
  at: string;
  firstLine: string;
}

export interface GraphEdge {
  kind: "message" | "spawn" | "relay";
  from: string;
  to: string;
  count: number;
  firstAt: string;
  lastAt: string;
  /** The last `perEdgeLines` first lines on this edge, oldest first. */
  lines: GraphEdgeLine[];
  gone: boolean;
}

export interface CommsGraphSnapshot {
  /** Monotonic. Bumped only when the graph actually changed. */
  seq: number;
  /** False when nothing changed since the client's `since`. */
  changed: boolean;
  /** True while a cold start is still filling in; the page says so. */
  truncated: boolean;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The most recent messages anywhere, newest last. */
  recent: (GraphEdgeLine & { from: string; to: string })[];
  stats: IndexerStats;
}

export interface IndexerStats {
  scans: number;
  bytesRead: number;
  linesParsed: number;
  filesTracked: number;
  nodes: number;
  edges: number;
  nodesDropped: number;
  edgesDropped: number;
  recentDropped: number;
  linesDropped: number;
  /** Records skipped because one line exceeded a whole tick's budget. */
  linesSkipped: number;
  /** Directories the walk was not allowed to read - nodes it will never show. */
  dirsUnreadable: number;
  truncated: boolean;
  lastScanMs: number;
  lastScanAt: string | null;
}

const DEFAULTS = {
  maxNodes: 2000,
  maxEdges: 2000,
  maxRecent: 2000,
  perEdgeLines: 12,
  maxFiles: 4000,
  maxBytesPerScan: 256 * 1024,
  minIntervalMs: 1000,
};

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/** One tailing cursor per tracked file. The only unbounded-looking thing here
 *  is `cursorOrder`, and that is bounded by maxFiles. */
interface Cursor {
  offset: number;
  size: number;
  ino: number;
  depth: number;
  sessionId: string;
  name: string | null;
  gone: boolean;
  isLedger: boolean;
}

/** `Map` with an LRU bound: oldest insertion first, which `Map` gives us free. */
class Lru<K, V> {
  private readonly map = new Map<K, V>();
  dropped = 0;
  constructor(private readonly cap: number) {}
  get size(): number {
    return this.map.size;
  }
  keys(): IterableIterator<K> {
    return this.map.keys();
  }
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  has(k: K): boolean {
    return this.map.has(k);
  }
  set(k: K, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.dropped++;
    }
  }
  delete(k: K): void {
    this.map.delete(k);
  }
  values(): V[] {
    return [...this.map.values()];
  }
}

interface StoredEdge extends GraphEdge {
  minute: Float64Array;
  hour: Float64Array;
  minuteHead: number;
  hourHead: number;
}

export class CommsGraphIndexer {
  private readonly opts: Required<Omit<IndexerOptions, "now">> & { now: () => number };
  private readonly cursors = new Map<string, Cursor>();
  private readonly cursorOrder: string[] = [];
  private readonly nodes: Lru<string, GraphNode>;
  private readonly edges: Lru<string, StoredEdge>;
  private readonly recent: (GraphEdgeLine & { from: string; to: string })[] = [];
  /** sessionId -> node key, so an id-keyed endpoint can be upgraded to a name. */
  private readonly idToKey = new Map<string, string>();
  /** Bounded: the same LRU bound as nodes, without the re-key dance. */
  private readonly idToKeyOrder: string[] = [];
  /** sessionId -> { mtimeMs, contextPct, status, live, model, endedAt }. Bounded. */
  private readonly metaCache = new Map<string, { mtimeMs: number; pct: number | null; status: string | null; live: boolean; model: string | null; endedAt: string | null }>();
  private seq = 0;
  private truncated = false;
  private lastScanAtMs = 0;
  private counters: IndexerStats = blankStats();

  constructor(options: IndexerOptions) {
    this.opts = { ...DEFAULTS, ...options, now: options.now ?? Date.now };
    this.nodes = new Lru(this.opts.maxNodes);
    this.edges = new Lru(this.opts.maxEdges);
  }

  /** Test hook: the incremental tests assert on per-tick deltas. */
  resetCounters(): void {
    const files = this.counters.filesTracked;
    const nd = this.counters.nodesDropped;
    const ed = this.counters.edgesDropped;
    const rd = this.counters.recentDropped;
    const ld = this.counters.linesDropped;
    const ls = this.counters.linesSkipped;
    const du = this.counters.dirsUnreadable;
    const scans = this.counters.scans;
    this.counters = blankStats();
    this.counters.filesTracked = files;
    this.counters.nodesDropped = nd;
    this.counters.edgesDropped = ed;
    this.counters.recentDropped = rd;
    this.counters.linesDropped = ld;
    this.counters.linesSkipped = ls;
    this.counters.dirsUnreadable = du;
    this.counters.scans = scans;
  }

  stats(): IndexerStats {
    return {
      ...this.counters,
      filesTracked: this.cursors.size,
      nodes: this.nodes.size,
      edges: this.edges.size,
      nodesDropped: this.nodes.dropped + this.counters.nodesDropped,
      edgesDropped: this.edges.dropped + this.counters.edgesDropped,
      truncated: this.truncated,
    };
  }

  /**
   * One tick. Returns immediately if `minIntervalMs` has not elapsed.
   *
   * A tick is: discover new files (a bounded walk of three known roots), then
   * read at most `maxBytesPerScan` NEW bytes across the cursors that moved, then
   * let the caps evict. It never re-parses a byte it has already parsed, which
   * is the whole point.
   */
  async scan(): Promise<void> {
    const started = this.opts.now();
    if (this.lastScanAtMs && started - this.lastScanAtMs < this.opts.minIntervalMs) return;
    this.lastScanAtMs = started;
    this.counters.scans++;
    this.counters.bytesRead = 0;
    this.counters.linesParsed = 0;
    this.truncated = false;

    let budget = this.opts.maxBytesPerScan;
    await this.discover();
    for (const file of this.cursorOrder.slice()) {
      if (budget <= 0) {
        this.truncated = true;
        break;
      }
      budget = await this.tail(file, budget);
    }
    // AFTER the tail: the meta file describes sessions that only exist as nodes
    // once their transcript header has been read, and a first tick has to read
    // the header before there is anything for the meta to describe.
    await this.readMeta();
    this.applyRelayEdges();
    this.counters.lastScanMs = Math.max(0, this.opts.now() - started);
    this.counters.lastScanAt = new Date(started).toISOString();
  }

  /**
   * Build the graph. Does not mutate the indexer's state.
   *
   * `since` is the whole "slow client" story: a client that polls every two
   * seconds with the `seq` it last saw gets `{changed:false, nodes:[], edges:[]}`
   * and a few hundred bytes, not the graph again. Nothing is buffered FOR the
   * client to be missed by; the client simply asks whether anything moved.
   */
  snapshot(options: { since?: number; windowMs?: number } = {}): CommsGraphSnapshot {
    const now = this.opts.now();
    void options.windowMs;
    const changed = options.since === undefined ? true : options.since !== this.seq;
    if (!changed) {
      return {
        seq: this.seq,
        changed: false,
        truncated: this.truncated,
        generatedAt: new Date(now).toISOString(),
        nodes: [],
        edges: [],
        recent: [],
        stats: this.stats(),
      };
    }
    return {
      seq: this.seq,
      changed,
      truncated: this.truncated,
      generatedAt: new Date(now).toISOString(),
      nodes: this.nodes.values().map((n) => ({ ...n })),
      edges: this.edges.values().map((e) => ({
        kind: e.kind,
        from: e.from,
        to: e.to,
        count: e.count,
        firstAt: e.firstAt,
        lastAt: e.lastAt,
        lines: e.lines.slice(-this.opts.perEdgeLines),
        gone: e.gone,
      })),
      recent: this.recent.slice(-this.opts.maxRecent),
      stats: this.stats(),
    };
  }

  // ---------------------------------------------------------------- discovery

  private async discover(): Promise<void> {
    await this.walk(path.join(this.opts.primeDir, "sessions"), 0, false);
    await this.walk(path.join(this.opts.primeDir, "session-artifacts"), 0, false);
    await this.walk(path.join(this.opts.primeDir, "rlm-ledger"), 0, true);
  }

  /**
   * `<sid>.meta.json` is the ONLY place the daemon writes "how full is this
   * session's context" and whether it is live. It is a small file next to the
   * transcript, rewritten as the session runs, so it is read by mtime and
   * cached. The cache is bounded like everything else here: a corpus with more
   * sessions than the cap stops learning about the oldest, which is the correct
   * order to stop in.
   */
  private async readMeta(): Promise<void> {
    const dir = path.join(this.opts.primeDir, "sessions");
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    let considered = 0;
    for (const name of names) {
      if (considered++ > this.opts.maxFiles) break;
      if (!name.endsWith(".meta.json")) continue;
      const sid = name.slice(0, -".meta.json".length);
      const full = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      const cached = this.metaCache.get(sid);
      if (cached && cached.mtimeMs === st.mtimeMs) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(await fsp.readFile(full, "utf8")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ctx = typeof m.contextTokens === "number" ? m.contextTokens : null;
      const win = typeof m.contextWindow === "number" && m.contextWindow > 0 ? m.contextWindow : null;
      const entry = {
        mtimeMs: st.mtimeMs,
        pct: ctx !== null && win !== null ? Math.min(100, Math.round((ctx / win) * 100)) : null,
        status: typeof m.status === "string" ? m.status : null,
        live: m.live === true,
        model: typeof m.model === "string" ? m.model : null,
        endedAt: typeof m.endedAt === "number" ? new Date(m.endedAt).toISOString() : null,
      };
      this.metaCache.set(sid, entry);
      while (this.metaCache.size > this.opts.maxNodes) {
        const oldest = this.metaCache.keys().next();
        if (oldest.done) break;
        this.metaCache.delete(oldest.value);
      }
      const node = this.idToKey.get(sid) ? this.nodes.get(this.idToKey.get(sid) as string) : undefined;
      if (!node) continue;
      node.contextPct = entry.pct;
      if (!node.model && entry.model) node.model = entry.model;
      // The daemon's own status, mapped to what a person watching the graph
      // needs to see. A session the daemon still calls "streaming" while no
      // worker holds it (`live: false`) is a STALLED session — that is the
      // MiniMax-plan-limit failure this whole workshop hit twice today, and
      // drawing it as working would be the one wrong the graph exists to stop.
      if (entry.status) {
        if (!entry.live && (entry.status === "streaming" || entry.status === "active")) {
          node.state = "stalled";
        } else if (!node.state) {
          node.state = entry.status;
        }
      }
    }
  }

  private async walk(dir: string, depth: number, isLedger: boolean): Promise<void> {
    if (this.cursors.size >= this.opts.maxFiles) {
      this.truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      // ENOENT is a fresh install and is not an error. A directory we are NOT
      // allowed to read is a different thing entirely: it holds sessions the
      // graph will silently never show, and the snapshot was about to claim it
      // had read everything. The corpus walk swallowed EACCES here and the page
      // said "live - 206 nodes" over a corpus with 890 sessions in it, with
      // `truncated: false`. A missing permission is a MISSING NODES signal.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "ELOOP" || code === "ENOTDIR") {
        this.truncated = true;
        this.counters.dirsUnreadable++;
      }
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "harness" || entry.name.startsWith(".")) continue;
        await this.walk(full, depth + 1, isLedger);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isLedger ? !entry.name.endsWith(".jsonl") : !UUID_JSONL.test(entry.name)) continue;
      if (this.cursors.has(full)) continue;
      if (this.cursors.size >= this.opts.maxFiles) {
        // The cap is on CURSORS. An uncursored file means "not tracked", not
        // "out of memory"; the node it produced stays until the node cap says.
        this.truncated = true;
        continue;
      }
      let st: fs.Stats;
      try {
        st = await fsp.stat(full);
      } catch {
        continue;
      }
      const sid = entry.name.replace(/\.jsonl$/i, "");
      this.cursors.set(full, {
        offset: 0,
        size: st.size,
        ino: st.ino,
        depth: isLedger ? 0 : depth,
        sessionId: sid,
        name: null,
        gone: false,
        isLedger,
      });
      this.cursorOrder.push(full);
    }
  }

  // ------------------------------------------------------------------- tailing

  private async tail(file: string, budget: number): Promise<number> {
    const cur = this.cursors.get(file);
    if (!cur) return budget;
    /**
     * THE SECOND BUG THIS MODULE HAD, and the more dangerous one.
     *
     * `truncated` used to be set only when the budget ran out with MORE FILES
     * still queued. So if the LAST file consumed the whole budget and still
     * had unread bytes, the tick ended with `truncated === false` and the
     * server told the page "here is the complete graph" about a graph it had
     * read a quarter of.
     *
     * A cold start over the 336 MB corpus happened to converge anyway, because
     * with 877 files there was almost always another one queued — which is
     * exactly how a wrong check survives: it is right on the data you tested
     * it with. A corpus of one large file would have reported a partial graph
     * as a whole one, silently, forever.
     *
     * So truncation is now a property of the FILE, not of the loop: every
     * return path asks whether this file still has bytes we have not read.
     */
    const settle = (spent: number): number => {
      if (cur.offset < cur.size) this.truncated = true;
      return spent;
    };
    let st: fs.Stats;
    try {
      st = await fsp.stat(file);
    } catch {
      this.cursors.delete(file);
      const i = this.cursorOrder.indexOf(file);
      if (i >= 0) this.cursorOrder.splice(i, 1);
      return budget;
    }
    const prevSize = cur.size;
    cur.size = st.size;
    if (st.ino !== cur.ino || st.size < cur.offset) {
      // Rotated or rewritten. Re-read from zero: skipping because the cursor is
      // past the new EOF is the bug that silently freezes a node forever.
      cur.offset = 0;
      cur.ino = st.ino;
      cur.name = null;
    }
    cur.size = st.size;
    if (st.size === cur.offset) return budget;

    const want = Math.min(budget, st.size - cur.offset);
    if (want <= 0) return settle(budget);
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, cur.offset);
      if (bytesRead <= 0) return settle(budget);
      this.counters.bytesRead += bytesRead;
      const text = buf.toString("utf8", 0, bytesRead);
      const lastNl = text.lastIndexOf("\n");
      if (lastNl < 0) {
        // No newline in the window. TWO different situations, and treating them
        // the same is how this file was broken once already.
        //
        // (a) There is more file past the window. Then this line is simply
        //     bigger than a whole tick's budget, and the cursor MUST move or
        //     the next tick re-reads the same bytes forever. The real corpus
        //     has a 1.6 MB single record — a transcript entry carrying a whole
        //     pasted document — six times the 256 KB budget. Skip to the next
        //     newline: a record that large is not a graph fact (the facts here
        //     are headers and small records) and `consume` drops unparseable
        //     lines anyway. What matters is that the cursor always advances.
        //
        // (b) The window ended AT end-of-file. Then it is a tail without a
        //     newline, and the only question is whether a writer is still
        //     adding to it. If the file has not grown since the last tick,
        //     nothing is writing, so the tail is final: take it as a line and
        //     stand at EOF. If it HAS grown, an appender is mid-line and the
        //     right answer is to wait for the newline — skipping here would
        //     silently drop a message that is a half-second from being sent.
        const atEof = cur.offset + bytesRead >= st.size;
        if (!atEof) {
          cur.offset = await skipToNewline(fh, cur.offset + bytesRead, st.size);
          this.counters.linesSkipped++;
          return settle(budget - bytesRead);
        }
        if (st.size > prevSize) return settle(budget); // a writer is mid-line: wait
        const tail = text.trim();
        if (tail) {
          this.counters.linesParsed++;
          this.consume(tail, file, cur);
        }
        cur.offset = st.size;
        return settle(budget - bytesRead);
      }
      const complete = text.slice(0, lastNl);
      cur.offset += Buffer.byteLength(complete, "utf8") + 1;
      for (const line of complete.split("\n")) {
        if (!line) continue;
        this.counters.linesParsed++;
        this.consume(line, file, cur);
      }
      return settle(budget - bytesRead);
    } finally {
      await fh.close();
    }
  }

  // ------------------------------------------------------------------- consume

  private consume(line: string, file: string, cur: Cursor): void {
    if (cur.isLedger) {
      this.applyLedger(line);
      return;
    }
    const fact: LineFact | null = extractLine(line, cur.sessionId, cur.depth);
    if (!fact) return;
    if (fact.kind === "session") {
      cur.depth = fact.depth;
      const node = this.nodeFor(fact.sessionId, file);
      node.id = fact.sessionId;
      node.depth = fact.depth;
      if (fact.cwd) node.cwd = fact.cwd;
      if (!node.startedAt) node.startedAt = readTs(line);
      this.remember(fact.sessionId, node.key);
      this.touch(node);
      return;
    }
    if (fact.kind === "name") {
      cur.name = fact.name;
      this.rekey(cur.sessionId, fact.name);
      this.touch(this.nodeFor(fact.name, file));
      return;
    }
    if (fact.kind === "model") {
      const node = this.nodeFor(this.keyOf(cur), file);
      node.model = fact.model; // the last model_change is the live one
      this.touch(node);
      return;
    }
    if (fact.kind === "session_state") {
      const node = this.nodeFor(this.keyOf(cur), file);
      node.state = fact.state;
      this.touch(node);
      return;
    }
    if (fact.kind === "agent_status") {
      const node = this.nodeFor(this.keyOf(cur), file);
      node.state = fact.taskState;
      this.touch(node);
      return;
    }
    if (fact.kind === "goal") {
      const node = this.nodeFor(this.keyOf(cur), file);
      node.goalStatus = fact.status;
      this.touch(node);
      return;
    }
    if (fact.kind === "relay_fired") {
      const node = this.nodeFor(this.keyOf(cur), file);
      if (!node.relayFiredAt) node.relayFiredAt = fact.at;
      this.touch(node);
      return;
    }
    if (fact.kind === "message") {
      this.recordMessage(fact.from, fact.to, fact.at, fact.firstLine, cur, file);
    }
  }

  private recordMessage(from: Endpoint, to: Endpoint, at: string, line: string, cur: Cursor, file: string): void {
    const fromKey = this.resolveKey(from, cur, file);
    const toKey = this.resolveKey(to, cur, file);
    if (fromKey === toKey && from.kind !== "external") return; // not an edge
    const edge = this.edgeFor("message", fromKey, toKey, at);
    // Scrubbed at INGEST, not at render: a ring that held raw message text
    // would keep a credential in the dashboard's heap for as long as the edge
    // existed, and there is no code path that could be trusted to scrub later.
    const safe = redact(line);
    edge.lines.push({ at, firstLine: safe });
    while (edge.lines.length > this.opts.perEdgeLines) {
      edge.lines.shift();
      this.counters.linesDropped++;
    }
    this.recent.push({ at, firstLine: safe, from: fromKey, to: toKey });
    while (this.recent.length > this.opts.maxRecent) {
      this.recent.shift();
      this.counters.recentDropped++;
    }
    const a = this.nodes.get(fromKey);
    if (a) {
      a.messagesOut++;
      this.touch(a);
    }
    const b = this.nodes.get(toKey);
    if (b) {
      b.messagesIn++;
      this.touch(b);
    }
  }

  private keyOf(cur: Cursor): string {
    return this.idToKey.get(cur.sessionId) ?? cur.sessionId;
  }

  /** Turn an endpoint into a node key, upgrading an id to a known name. */
  private resolveKey(ep: Endpoint, cur: Cursor, file: string): string {
    if (ep.kind === "external") {
      const node = this.nodeFor(ep.key, ep.key);
      node.kind = "external";
      node.name = ep.name ?? `ext ${String(ep.clientId ?? "?").slice(0, 8)}`;
      this.touch(node);
      return ep.key;
    }
    if (ep.name) return ep.name;
    if (ep.sessionId) {
      const known = this.idToKey.get(ep.sessionId);
      if (known) return known;
      const node = this.nodeFor(ep.sessionId, ep.sessionId);
      node.id = ep.sessionId;
      this.touch(node);
      return node.key;
    }
    return this.keyOf(cur);
  }

  private remember(sessionId: string, key: string): void {
    if (this.idToKey.get(sessionId) === key) return;
    if (this.idToKeyOrder.length >= this.opts.maxNodes) {
      const oldest = this.idToKeyOrder.shift();
      if (oldest !== undefined) this.idToKey.delete(oldest);
    }
    this.idToKey.set(sessionId, key);
    this.idToKeyOrder.push(sessionId);
  }

  private nodeFor(key: string, file: string): GraphNode {
    const existing = this.nodes.get(key);
    if (existing) return existing;
    const looksLikeId = UUID_JSONL.test(`${key}.jsonl`);
    const node: GraphNode = {
      key,
      id: looksLikeId ? key : null,
      name: looksLikeId ? `${key.slice(0, 8)}…` : key,
      kind: file.includes(`${path.sep}session-artifacts${path.sep}`) ? "child" : "lead",
      parent: null,
      depth: 0,
      model: null,
      state: null,
      goalStatus: null,
      contextPct: null,
      cwd: null,
      startedAt: null,
      lastActivityAt: null,
      gone: false,
      relayFiredAt: null,
      messagesIn: 0,
      messagesOut: 0,
      spawnChildren: 0,
      spawnedChildrenGone: 0,
    };
    this.nodes.set(key, node);
    return this.nodes.get(key)!;
  }

  private touch(node: GraphNode): void {
    const now = new Date(this.opts.now()).toISOString();
    if (!node.lastActivityAt || node.lastActivityAt < now) node.lastActivityAt = now;
    this.nodes.set(node.key, node); // refresh LRU position
    this.seq++;
  }

  /** Move a node from an id-key to a name-key, carrying every edge with it. */
  private rekey(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return;
    const node = this.nodes.get(oldKey);
    if (!node) return;
    node.key = newKey;
    node.name = newKey;
    this.nodes.delete(oldKey);
    this.nodes.set(newKey, node);
    if (node.id) this.remember(node.id, newKey);
    for (const stored of this.edges.values()) {
      if (stored.from === oldKey) stored.from = newKey;
      if (stored.to === oldKey) stored.to = newKey;
    }
    for (const r of this.recent) {
      if (r.from === oldKey) r.from = newKey;
      if (r.to === oldKey) r.to = newKey;
    }
  }

  private edgeFor(kind: "message" | "spawn" | "relay", from: string, to: string, at: string): StoredEdge {
    const key = `${kind} ${from} ${to}`;
    const existing = this.edges.get(key);
    if (existing) {
      existing.count++;
      if (existing.lastAt < at) existing.lastAt = at;
      return existing;
    }
    const edge: StoredEdge = {
      kind,
      from,
      to,
      count: 1,
      firstAt: at,
      lastAt: at,
      lines: [],
      gone: false,
      minute: new Float64Array(60),
      hour: new Float64Array(24),
      minuteHead: 0,
      hourHead: 0,
    };
    this.edges.set(key, edge);
    return this.edges.get(key)!;
  }

  // ------------------------------------------------------------- rlm ledger ops

  private applyLedger(line: string): void {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const op = d.op;
    const nowIso = new Date(this.opts.now()).toISOString();
    if (op === "spawn") {
      const parentPath = typeof d.parent === "string" ? d.parent : null;
      const childPath = typeof d.child === "string" ? d.child : null;
      const at = typeof d.at === "string" ? d.at : nowIso;
      if (!childPath) return;
      const childSid = path.basename(childPath).replace(/\.jsonl$/i, "");
      const ledgerName = typeof d.name === "string" && d.name ? d.name : null;
      const child = this.nodeFor(ledgerName ?? childSid, childPath);
      child.kind = "child";
      child.depth = typeof d.depth === "number" ? d.depth : 1;
      this.remember(childSid, child.key);
      if (parentPath) {
        const parentKey = this.keyForFile(parentPath);
        if (parentKey) {
          const parent = this.nodeFor(parentKey, parentPath);
          child.parent = parent.key;
          parent.spawnChildren++;
          const edge = this.edgeFor("spawn", parent.key, child.key, at);
          edge.count = 1;
          edge.gone = false;
          this.touch(parent);
        }
      }
      this.touch(child);
      return;
    }
    if (op === "delete") {
      const childPath = typeof d.child === "string" ? d.child : null;
      if (!childPath) return;
      const childSid = path.basename(childPath).replace(/\.jsonl$/i, "");
      const key = this.idToKey.get(childSid) ?? childSid;
      const child = this.nodeFor(key, childPath);
      child.gone = true;
      if (child.parent) {
        const parent = this.nodes.get(child.parent);
        if (parent) {
          parent.spawnedChildrenGone++;
          this.touch(parent);
        }
        this.edgeFor("spawn", child.parent, key, nowIso).gone = true;
      }
      this.touch(child);
    }
  }

  private keyForFile(file: string): string | null {
    const cur = this.cursors.get(file);
    if (cur) return cur.name ?? this.idToKey.get(cur.sessionId) ?? cur.sessionId;
    const sid = path.basename(file).replace(/\.jsonl$/i, "");
    return this.idToKey.get(sid) ?? null;
  }

  // ------------------------------------------------------------------ relay pass

  private applyRelayEdges(): void {
    const candidates = this.nodes
      .values()
      .filter((n) => n.kind === "lead" && !!n.name && !!n.relayFiredAt)
      .map((n) => ({
        key: n.key,
        name: n.name,
        cwd: n.cwd,
        startedAt: n.startedAt ?? new Date(0).toISOString(),
        relayFiredAt: n.relayFiredAt,
      }));
    for (const rel of resolveEndpoints(candidates)) {
      if (this.edges.has(`${rel.kind} ${rel.from} ${rel.to}`)) continue;
      const at = this.nodes.get(rel.to)?.startedAt ?? new Date(this.opts.now()).toISOString();
      const edge = this.edgeFor(rel.kind, rel.from, rel.to, at);
      edge.count = 1;
      this.touch(this.nodeFor(rel.from, rel.from));
      this.touch(this.nodeFor(rel.to, rel.to));
    }
  }
}

// -------------------------------------------------------------------- helpers

function blankStats(): IndexerStats {
  return {
    scans: 0,
    bytesRead: 0,
    linesParsed: 0,
    filesTracked: 0,
    nodes: 0,
    edges: 0,
    nodesDropped: 0,
    edgesDropped: 0,
    recentDropped: 0,
    linesDropped: 0,
    linesSkipped: 0,
    dirsUnreadable: 0,
    truncated: false,
    lastScanMs: 0,
    lastScanAt: null,
  };
}

/**
 * Advance past an over-long line to the byte after the next newline.
 *
 * Bounded by a fixed number of reads and a fixed chunk size, so a pathological
 * file (one line with no newline in it for a gigabyte) cannot make this loop
 * unbounded: if no newline turns up, the file's end is returned and the cursor
 * sits at EOF, which is the same position a truncated line would leave it at.
 */
async function skipToNewline(fh: fsp.FileHandle, from: number, size: number): Promise<number> {
  const CHUNK = 256 * 1024;
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, size - from)));
  let at = from;
  for (let i = 0; i < 64 && at < size; i++) {
    const want = Math.min(buf.length, size - at);
    if (want <= 0) break;
    const { bytesRead } = await fh.read(buf, 0, want, at);
    if (bytesRead <= 0) break;
    const nl = buf.toString("utf8", 0, bytesRead).indexOf("\n");
    if (nl >= 0) return at + Buffer.byteLength(buf.toString("utf8", 0, bytesRead).slice(0, nl), "utf8") + 1;
    at += bytesRead;
  }
  return size;
}

function readTs(line: string): string | null {
  const m = /"timestamp":"([^"]+)"/.exec(line);
  return m ? m[1] : null;
}

export { firstLine };
