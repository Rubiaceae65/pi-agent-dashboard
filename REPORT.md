# comms graph — a live picture of who is talking to whom

> **This file is now committed in the tree**, at the repo root, because the job's
> Done condition asks for `REPORT.md` in the tree and the first copy lived only
> in the session directory. It is the same report; where the two differ, this
> one is the one that ships. Paths inside it are repo-relative. The raw
> measurements, the full-size screenshots and the two recordings are NOT in the
> tree — they live in the session directory `/projects/comms-graph-20260930/`
> (`artifacts/`, `shots/`), because they are large and because a picture of a
> corpus that no longer exists is worth less than the corpus.

A read-only view of the communication network between agent sessions, built into
the pi-agent-dashboard at **`/graph/`**. Every lead, relay successor, rlm child
and external sender is a node; every message is an edge; the parent/child and
relay relations are drawn alongside the message traffic.

## Summary

1. `GET /api/comms/graph` plus a static `/graph/` sub-app, same origin and same guard as `/mobile/` and `/links/`.
2. The page polls `?since=<seq>` every 2 s. Nothing moved means a 379-byte response; no websocket, no per-client server state.
3. Read-only by construction: no POST handler, no handle, no parameter that names a session to act on.
4. The indexer tails by byte offset, so over a 336.5 MB / 877-file corpus steady-state polling reads **0 bytes** and costs 300 kB RSS.
5. Cold start is 1,356 ticks in 38.9 s, slowest tick 183 ms, RSS +107.4 MB — bounded, and it does not stall.
6. Only first lines of messages are retained, and secrets are scrubbed **at ingest**, so no credential is ever stored to be cleaned up later.
7. 115 tests pass across 7 files; three real bugs were found by measuring and by looking at screenshots, not by the tests.
8. Two indexer defects the tests had missed were fixed: a 1.6 MB line stalled the cursor forever, and `truncated` could claim completion with bytes unread.
9. A 200 from this dashboard does **not** prove a route exists — the SPA fallback answers unmatched paths with 200 and HTML, so the client validates JSON instead.
10. The first converged view was unreadable at 234 nodes; labels are now rationed by traffic, which is what the screenshots are really about.

11. The scrubber catches a credential by SHAPE, not by context: after the verifier's token walked through six phrasings, `Bearer` is scrubbed wherever it appears — bare, colon-separated, lower case, in prose, inside a `curl` — and ordinary English like `bearer tokens live in the vault` still survives.
12. One malformed row cannot take the phone view down. `isRlmChild` is total, and junk rows are dropped at the walk rather than drawn.

The measured numbers are in `artifacts/memory-footprint.json`, the screenshots
and what each one proves are in `shots/CAPTIONS.md`, and every defect is
written up in `artifacts/failing-first.md` — all three in the session directory
`/projects/comms-graph-20260930/`, not in this tree.

## What it looks like

![the converged graph](docs/shots/comms-graph-live.png)

![node detail](docs/shots/comms-graph-node-detail.png)

The footer in that first shot is the load-bearing claim made visible: a 155 MB
corpus polled every two seconds, reading `0 B this tick`.

The interaction, captured from the real display (3 fps, see the limits below):
`shots/graph-interaction.webm`.

## Shape of the work

```
packages/server/src/comms-graph/
  extract.ts        session/message/spawn/relay facts from a JSONL line
  indexer.ts        one corpus -> nodes, edges, recent; byte-cursor incremental
  redact.ts         secret scrubbing, run before anything is retained
  route.ts          the read-only route
  measure.mjs       the memory/throughput measurement
  transpile.mjs     esbuild pass, for a runtime with no toolchain
public/graph/       model, seeded layout, canvas, page
```

Two decisions worth stating, because both were forced by the data rather than
preferred:

**The indexer is self-contained.** The session stream carries messages but not
who sent them to whom, so merging it with a second source to recover
relationships would have meant trusting two clocks. Instead the indexer reads
the same underlying files the sessions come from, with bounded cursors.

**Polling, not a socket.** A websocket would have meant per-client buffers and
a second thing to leak. Polling with a sequence number needs none of that, and
the unchanged response is 379 bytes.

**Relay edges are corroborated, not inferred.** An edge is drawn only when the
name says `-N`, the predecessor logged `atelier-prime-relay fired:true`, both
ran in the same directory, and the successor started afterwards. Guessing from
a name pattern alone would have drawn edges that never happened — visible in the
captures as `brain2-parity-20260930 → brain2-parity-20260930-2`.

## Honest limits

- **The recording claim below is SUPERSEDED — `atelier-record` does work.**
  `atelier-gui record` still returns `ok: true` and writes a **0-byte** file, but
  the sanctioned `atelier-record` records the display correctly. What fails is
  asking it for `libx264` inside a `.webm`:

  ```
  [webm @ ...] Only VP8 or VP9 or AV1 video and Vorbis or Opus audio
                and WebVTT subtitles are supported for WebM.
  Failed to write file header
  ```

  Same recorder, same codec, `.mp4` instead of `.webm`:
  `atelier-record start --name x --out shots/graph-live.mp4 --audio none`
  produced **891.9 s / 9.1 MB** of the cold start running, and a second pass
  produced `shots/graph-tour.mp4`, **61.9 s / 696 kB**, of the interactions. So
  the 0-byte result is a container/codec mismatch, not a missing recorder, and
  the `grim`-at-3fps fallback is no longer needed. (Session 1's finding
  `20260930-191343-tool-bug-atelier-gui` is about `atelier-gui record clip`,
  which is a different command and may still be true.)
  The earlier fallback, kept for the record:
  `shots/graph-interaction.webm` was made by
  capturing real frames of the real display with `grim` at ~3 fps while driving
  the page with `atelier-gui`, then encoding with `ffmpeg -c:v libvpx-vp9`:
  1280x720, 13.3 s, 338 KB. It is genuine screen content, and 12 of the 40
  frames are byte-distinct, so the interaction is really in it — but it is
  **3 fps, not a smooth capture**, and it is not what `atelier-gui record`
  would have produced. If the tool is fixed, re-record with it.
- **Exercised through the real server, against a COPY of the corpus.** Session 2
  booted `createServer()` from `packages/server/src/server.ts` itself inside the
  sandbox with `PRIME_AGENT_HOME` pointed at `artifacts/corpus-snapshot`, served
  `/graph/` from it and drove it in the shared browser — so the route, the guard
  and the static sub-app were exercised end to end, 877 files and all. What is
  still unproven is the DEPLOYED binary on the live daemon: not the live daemon's
  own file churn over hours against the cursors, and not the panels gateway's
  proxy in front of it.
- **The gateway mounted-prefix shape is unit-tested, not deployed.**
- **"Live" is demonstrated as "polls cheaply and re-renders on change."** The
  corpus was static, so no capture shows the graph moving as messages arrive.
- **Sessions with no `session_info` record keep a truncated id as their label**
  (e.g. `01a0e94b…`). That is honest — the name genuinely is not in the
  transcript — but it is why a few nodes read as hex.
- External senders keep a `clientId` label. 257 of 773 agent-message records
  carry a `clientId` with no `sessionName`; guessing which of them are the host
  and which are the owner would have been invention.

---

# For the host

> **State at hand-off, in one line:** the work is finished, green, and **pushed**.
> The branch is on the remote at `origin/comms-graph-20260930`, and the sha below
> was read back FROM the remote, not from my own memory of what I pushed.
> Nothing is outstanding.

**Branch head: `6a7c1a235`** on `comms-graph-20260930`, based on `720fb0c02`
(the `dash-subagents-20260930` tip, which contains the `49dd69608` the host said
lands first). The code head is `ff421f628`; the one commit above it adds this
report. I did not amend to bake a sha into the file that the sha names — the
sha would change the file and the file would change the sha — so the report says
which commit is which.

**Pushed, and verified from the far side:**

```
$ git push -u origin comms-graph-20260930:comms-graph-20260930
   6745a99d6..6a7c1a235  comms-graph-20260930 -> comms-graph-20260930

$ GIT_TERMINAL_PROMPT=0 git ls-remote origin comms-graph-20260930
6a7c1a235b81fbedc5b794b156781d2cf6856b80	refs/heads/comms-graph-20260930
```

An earlier hand-off said this branch could never be pushed from brain2. That was
true when it was written and is false now — a credential helper has since become
available — so the claim is corrected here rather than left standing. The
`GIT_TERMINAL_PROMPT=0` matters: without it, `ls-remote` fails on the missing
prompt and looks exactly like a permissions failure. I nearly filed that as "the
push did not work".

Commits, oldest first:

| sha | what |
|---|---|
| `c87d86c6b` | extraction rules and the bounded incremental indexer |
| `ba7b272bc` | the read-only route, the scrubber, `/graph` as a guarded sub-app |
| `47ae7ccab` | the `/graph` sub-app: model, seeded layout, canvas, page |
| `22531dc2d` | two indexer stalls the memory measurement found and the tests had not |
| `a343533c6` | reach the data route relatively first, for the panels gateway |
| `9079fa31d` | a 200 is not proof the data route exists |
| `2f57fb343` | ration labels by traffic, transpile with esbuild, add the captures the README references |
| `68c50dd53` | an unreadable corpus directory was silently dropping every rlm child |
| `7d5f0b5fd` | `docs/comms-graph.md` — where every field comes from, and how the footprint was measured |
| `7268e8f75` | "hide finished" was a checkbox that changed nothing |
| `6745a99d6` | the screenshots, in `docs/shots/` |
| `82aab1073` | the busiest hub always gets its name — the label budget scored on messages, and the loudest thing on the canvas is a quiet node |
| `566ab262b` | the hub capture, re-converged from cold |
| `611979654` | the hub-cap test could not fail; now it does |
| `39d4e9758` | the habit written down: four checks in this feature were right only on the data they were tested with |
| `982b787bf` | the verifier's REQUIRED fix: a bearer is scrubbed wherever it appears, not only after `authorization:` |
| `ff421f628` | the verifier's phone-view finding: one null row cannot take the whole list down |
| _(one commit on top)_ | this report, committed into the tree as the job's Done requires |

# The verifier's conditional pass, and the three things it asked for

The verifier gave this branch a **CONDITIONAL PASS** at `39d4e9758`
(`checks-11-comms-graph/VERDICT.md`): read-only proven by checksum, memory bounds
that fire when the caps shrink, a slow client that cannot grow the server, the
SPA-200 trap fixed from a measurement, and a vacuous test of my own that I had
already caught. Two required items and one finding followed. All three are now in.

**1. The bearer leak (REQUIRED).** They planted a token of their own devising —
`Zqv7alphaBRAVO9912secret`, which appears nowhere in this branch — and six
phrasings of it walked through the graph in full: bare `Bearer <t>`,
`Bearer: <t>`, lower case, trailing dot, in prose, and inside `curl -H Bearer <t>`.
The rule was anchored on the literal word `authorization:`, so it had only ever
caught the header form.

This is the fifth time this branch has produced the same defect, and that is the
part worth keeping. My one bearer test used the `Authorization:` form; that was
the only form I ever tried. The rule was not wrong by accident — it was right on
exactly the data I had tested. `982b787bf` widens it to
`\b(bearer|basic|digest|token)(\s*[:=]\s*|\s+)([A-Za-z0-9._~+/=-]{12,})` and
keeps the scheme word, because *which* scheme it was is what makes the line
actionable. The failure mode of a wider rule is eating English, so the candidate
must look like a credential — a digit anywhere, or mixed case at length — and
that has a test too, because "it does not over-redact" is as much a claim as "it
redacts".

The seven verifier cases are tests, written red first (7 failed / 22 passed,
reproducing their count exactly) and mutation-checked in both directions:
inverting the digit test turns 6 red, and flipping the length guard changed
nothing — so that guard was unreachable and is deleted rather than left as
decoration.

**2. `REPORT.md` was missing from the tree.** It existed only in the session
directory. The job's Done asks for it in the tree; it is now at the repo root,
with its image paths repointed and its numbers updated. The raw measurements and
recordings stay outside the tree on purpose, and the report says so.

**3. `sessionName(null)` took the whole list down (phone view).** A literal
`null` element in `/api/sessions` threw out of `flattenWithChildren` while
reading `s.parentSessionId`, so the phone rendered nothing at all — not a
degraded list, not an error row. `ff421f628` makes the predicate total and drops
junk rows at the top of the walk, where a row with no `id` is established as not a
session rather than a degraded one. Four tests red before, green after, and the
undo is mutation-checked too.

**A note on the wider suite.** The server suite has 6 failing tests outside this
feature (`auth`, `localhost-guard`, `spa-fallback`, `mcp-manifest-completeness`,
`host-gate-inject`, `core-goal-free`). I did not assume they were pre-existing: a
clean worktree at `39d4e9758` fails the same 6 files the same way. They belong to
the base branch. The feature's own suite is 115 tests, 7 files, all green.

## How to deploy

1. Merge or cherry-pick onto the dashboard branch.
2. `pnpm install && pnpm build` in the repo root.
3. Start the dashboard as usual. No new environment variable is required; set
   `PRIME_AGENT_HOME` **only** if the sessions live somewhere other than
   `~/.prime/agent/sessions`, otherwise the default is used.
4. Behind the panels gateway the data route is mounted at the same prefix
   (`/graph/api/` → `/api/comms/`); the page tries that first and falls back to
   `/api/comms/graph`. No configuration is needed for either shape.
5. The route inherits the existing dashboard guard and login. No new auth was
   added, and none should be: it is a GET that reads the same files the rest of
   the dashboard already reads.

## Where it will live

**`/graph/`** — same origin, same guard as `/mobile/` and `/links/`.

Against the running dashboard on the Brain that is
`http://100.119.149.25:8000/graph/`.

The prototypes used for the screenshots both ran inside
`host:comms-graph-20260930-worker`, reading a copied corpus: session 1's at
`http://127.0.0.1:8099/graph/` and session 2's at `http://127.0.0.1:8111/graph/`
against the full 336 MB corpus. The sandbox is stopped but preserved, so either
can be brought back with `incus start host:comms-graph-20260930-worker`.

## Checking it without trusting it

```bash
# 82 tests, 5 files
HOME=$(mktemp -d) npx vitest run --root packages/server src/comms-graph/__tests__/

# the incremental claim, measured
node packages/server/src/comms-graph/measure.mjs
```

A fresh `HOME` matters: the suite writes session state under `$HOME`.

What would make these claims false, and is worth checking rather than
believing: a corpus whose largest single line exceeds the read chunk (a 1.6 MB
line already broke this once), a route that answers `200` with HTML, and a node
count high enough to make the label ration look arbitrary. The label budget is
a function of node count for exactly that reason.

---

# Session 2 (`comms-graph-20260930-2`): the sandbox prototype, the recordings, and four more defects

Everything above is session 1's report. This section is later and it overrides
it where the two disagree.

## The prototype

Booted the real dashboard server inside `host:comms-graph-20260930-worker` with
`PRIME_AGENT_HOME` pointed at a **copy** of the corpus
(`artifacts/corpus-snapshot`, 336.5 MB, 877 files), served it, and drove it in
the **shared** browser over CDP (`atelier-app start atelier-browser`, then
`connectOverCDP`) — never `chromium.launch()`, so a person could watch and take
over. The recipe, because it cost an hour:

```bash
FORK_ROOT=/projects/comms-graph-20260930/fork \
PRIME_AGENT_HOME=/projects/comms-graph-20260930/artifacts/corpus-snapshot \
  npx vite-node --config packages/server/vitest.config.ts \
  /projects/comms-graph-20260930/scripts/boot-graph-copy.ts 8111
```

`vite-node` with the repo's own vitest config is what works: it carries the
workspace aliases the server needs, which plain `node --import jiti` and plain
`createJiti` do not. Two operational notes: `incus exec ... pkill` kills the exec
client and not the node process inside the sandbox (I chased a stale 404 for ten
minutes before noticing the old server was still serving the old corpus), and a
second server on the same box dies with `pi-gateway: start() after
startOnSocket()` because the first still holds `gateway-0.sock`.

The cold start is real and slow: **1356 scans at a floor of one per second is
about 22 minutes** for this corpus, and the page says `filling in… (N nodes so
far)` the whole time. Converged: **528 nodes, 953 edges**, matching the
measurement exactly.

## The captures

`shots/CAPTIONS.md` lists all of them; session 1's are kept next to mine.

| file | what it shows |
|---|---|
| `01-filling-in.png` | the cold start, page saying `filling in… (136 nodes so far)` |
| `02-graph-live.png` | converged: 528 nodes, 953 edges, children clustered with `+n` badges |
| `02b-graph-live-67.png` | the same at 67% zoom — how much of the estate fits |
| `03-node-detail.png` | a node: model, run dir, age, badges, parent, message first lines |
| `04-edge-detail.png` | an edge: direction, count, first/last, the message on it |
| `05-filters-15min-subtree-hidefinished.png` | 15 min, one lead, hide finished — `144 nodes · 71 edges · 55 clusters` |
| `06-filters-hidefinished-off.png` | the same view, hide finished unticked — `223 nodes · 157 edges` |

* `shots/graph-live.mp4` — 891.9 s, 9.1 MB, the display while the cold start ran.
* `shots/graph-tour.mp4` — 61.9 s, 696 kB: load, hover, click a node, click an
  edge, drop to the 15-minute window, untick *hide finished*. Its last footer
  line (`223 nodes · 157 edges`) matches `06-filters-hidefinished-off.png`, so
  the video and the stills are the same run.

The key images are in the repo at `fork/docs/shots/comms-graph-*.png` and
embedded in `fork/docs/comms-graph.md`.

The red cluster in these pictures is real, and worth saying out loud: 169
`agent_status` records in this corpus carry `taskState: "error"` with the summary
`Model request failed: Provider rate limit exceeded ... Token Plan usage limit
reached`. That is the day's 429 storm, drawn as what it was.

## A fifth defect, found by a peer reading the picture

`comms-graph-20260930` (session 1) read the converged screenshot and pointed at
the dominant hub — the pale node with ~25 children radiating from it — and
correctly noted it was UNLABELLED. It is the first thing a reader looks at. The
label budget scores on message volume plus cluster size, and that node is quiet,
so three nodes with a `+1` badge made the cut and the hub did not.

Message volume answers "who was busy lately", which is not the same question as
"what is this thing in the middle of the picture". Fixed in `82aab1073`: labels
are now guaranteed for any node whose degree in the **drawn graph** is at least
`max(4, 2 × median degree)`, capped at 8 hubs so the promise cannot become the
wall of text the rationing exists to prevent. The decision moved out of the
canvas into `model.js` as `labelSetFor`, with four tests written first and red
(`TypeError: labelSetFor is not a function`), and the renderer is now a
two-line delegation that cannot drift from them. 86 tests.

Verified the same way it was found: re-converge the whole 336 MB corpus from
cold and look again. `shots/07-hub-labelled.png` against `02-graph-live.png` —
the hub is now `mail-consumer-rework-20260930 +2`.

## A test that could not fail, caught by a peer breaking it

The test guarding `MAX_HUB_LABELS` asserted `keep.size <= cap + 8` on a **4-regular
ring**. A `2 x median` rule can never fire on a regular graph — every node equals
the median, so the floor is above every degree — so `hubs` was always empty and
the assertion compared 12 to 20. `comms-graph-20260930` (session 1) set the cap to
100000, reran, and watched 28 tests pass.

The cap is the only thing stopping "every hub is named" from becoming the wall of
text the rationing exists to prevent, and the suite did not know it. The fixture
is now **skewed** — 12 connectors each wired to 10 of 30 leaves, leaves at degree
4, connectors at 10, median 4, floor 8, all 12 qualifying — and the tests assert
exactly 8 hubs labelled and `keep.size === 12`. With the cap removed: **2 failed**,
on precisely the two assertions that exist for it. Restored: 88 green.

The regular-graph case is kept, now asserting what it actually demonstrates (the
rule is silent there) with the reason written beside it, so the next person does
not spend an hour building a fixture that cannot fire.

## Four defects that running it found, none of them by reading the code

1. **`truncated` only when more files were queued** (`22531dc2d`). Every corpus
   in the repo had more than one file in it.
2. **An unreadable directory silently removed every rlm child** (`68c50dd53`).
   `readdir` failing with EACCES was treated exactly like ENOENT. Found by
   reading the NODE COUNT ON A SCREENSHOT: 206 nodes against a measurement that
   said 528, and a kind breakdown with **zero** children in it. Now EACCES /
   EPERM / ELOOP / ENOTDIR set `truncated` and bump `stats.dirsUnreadable`, and
   there is a test that an ABSENT root stays quiet so the fix cannot become
   "always say truncated".
3. **"Hide finished" was decoration** (`7268e8f75`). `selectGraph` ended in
   `void hideFinished`. Found by unticking it during a screenshot pass and
   getting the identical graph back. The two filter screenshots above are the
   regression evidence.
4. **A `200` was treated as proof a route exists** (`9079fa31d`). This
   dashboard's SPA fallback answers an unmatched path with 200 and the HTML
   shell, so the relative-first data route "worked" and returned `<!doctype`.
   The same lie was inside a passing test — `route.test.ts` asserted "POST is a
   404", which is only true when there is no client build.

The pattern is the transferable part: a check is only as good as the corpus it
has seen, and three of these four were green on every corpus in the repository.

## Findings filed

* `20260930-190019-gap-sandbox_creation_recipe_in__etc_atelier_` — the documented
  sandbox-create command names two profiles that do not exist
  (`atelier-toolkit`, `atelier-net-nat`). A fresh sandbox has no `atelier-app`
  at all until `incus config device add <n> toolkit disk
  source=/home/user/atelier-toolkit path=/opt/atelier` is added by hand.
* `20260930-190448-tool-bug-pi-dashboard_SPA_fallback_answers_every_` — the SPA
  fallback answers **every** unmatched request with 200 and the shell, POSTs to
  API paths included.
* Session 1: `20260930-191343-tool-bug-atelier-gui` (`atelier-gui record clip`
  writes 0 bytes) and the brain2 harness-write gap.

## What is still unproven

The deployed binary on the live daemon, over hours, against real file churn — the
cursors have been exercised by a static corpus and by tests, not by a day of
sessions growing underneath them. And the panels gateway's proxy in front of
`/graph/api/`: the shape is agreed with `panels-integration-20260930-2` and
unit-tested, but not deployed.
