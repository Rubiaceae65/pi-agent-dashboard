# mobile-poc — phone client for the pi-agent-dashboard API

A throwaway PWA that does the **minimum phone flow** against the dashboard's
existing API: list sessions, open one, follow it live, send a message, stop it.

**No server change of any kind.** It uses only what already exists:

| what | how |
| --- | --- |
| session list | `GET /api/sessions` |
| live stream + resume | `WS /ws?ticket=…`, protocol in `packages/shared/src/browser-protocol.ts` |
| send | `{"type":"send_prompt","sessionId","text","delivery":"followUp"}` |
| stop | `{"type":"abort","sessionId"}` |

Four WS message types in total (`subscribe`, `unsubscribe`, `send_prompt`, `abort`)
plus the two server pushes it renders (`event`, `event_replay`).

## Reconnect / resume

`subscribe` takes an optional `lastSeq`. The client remembers the highest `seq` it
has drawn and sends it on every (re)subscribe, so a dropped phone link resumes
where it left off instead of restarting the stream. This is the server's existing
`EventReplayMessage` contract — the PoC just uses it.

## Where the source lives, and how it is served

The client is `public/mobile/` in this repo. Vite copies `public/` verbatim into
the client build, `@fastify/static` serves that at `/`, and
`packages/server/src/routes/static-subapp-route.ts` answers the slashless
`/mobile` with a 308 to `/mobile/`. So there is one origin, one process, and no
CORS grant — open **`<dashboard>/mobile/`** on a phone and it talks to that same
dashboard's `/api` and `/ws`.

This file is `docs/mobile-poc.md` rather than `public/mobile/README.md` on
purpose: anything under `public/` is copied into `dist/` and therefore SERVED.
A README describing the API surface has no business at a public URL.

## Run it

Served by the dashboard itself:

    GET <dashboard>/mobile/          # the client
    GET <dashboard>/mobile           # 308 -> /mobile/

Then `POST /api/ws-ticket {"scope":"browser"}` and connect to `/ws?ticket=…`.

## The blocker that is not a UI problem

`POST /api/ws-ticket` and `/api/tools` are behind `networkGuard`, which admits
loopback, a `trustedNetworks` CIDR, or a paired-device bearer. The PoC host
(`tools/poc-host.js`) was scaffolding; the PWA is served by the dashboard itself
and there is no second origin at all.

Before a phone can be *any* good — the existing web client included — the
dashboard needs one of:

1. `trustedNetworks: ["100.64.0.0/10"]` in `~/.pi/dashboard/config.json` (tailnet only), or
2. a paired device holding a durable bearer token, or
3. a real auth proxy in front of it.

## Known limitation of this PoC

It renders a flat, plain-text transcript. It does not render tool calls as rich
cards, diffs, or canvas artifacts the way the desktop client does. That is
deliberate — it is the floor of what a phone needs, and the part that decides
whether a phone is useful.
