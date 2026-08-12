# pi-mesh — live agent-to-agent communication for Pi

![CI](https://github.com/cgarrot/pi-mesh/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/cgarrot/pi-mesh/actions/workflows/release.yml/badge.svg)
![npm](https://img.shields.io/npm/v/pi-mesh-extension)
![License](https://img.shields.io/npm/l/pi-mesh-extension)

**pi-mesh** is a standalone **Pi extension** for live agent-to-agent
communication. Local Pi agents talk to each other in < 50 ms through a tiny
local broker (NDJSON frames over a unix socket or named pipe, protocol
`mesh.v1`). Presence is **observed** (live sockets), statuses are **honest**
(`delivered` ≠ `read` ≠ `answered`), and the durable ledger is **hash-only**
(message bodies are never persisted). Zero runtime dependencies, Node ≥ 20.

```
                ┌────────────────────────────────────────────┐
                │  broker (detached) $TMPDIR/mesh-<uid>/     │
                │  peers / rooms / mailbox / rates (memory) │
                └───────▲───────────────▲─────────────▲──────┘
                        │ connexions persistantes NDJSON │
        ┌───────────────┴───┐   ┌───────┴────────┐   ┌┴───────────────┐
        │ client (agent A)  │   │ client (agent B)│   │ CLI mesh       │
        └───────▲───────────┘   └───────▲────────┘   └────────────────┘
        ┌───────┴───────────┐   ┌────────┴────────┐
        │ extension Pi A    │   │ extension Pi B  │
        │ mesh_send/reply/… │   │ injection       │
        │ ledger hash-only  │   │ followUp/steer/ │
        │ transcript opt-in │   │ abort+steer     │
        └───────────────────┘   └─────────────────┘
```

## Features

- **Honest statuses** — `delivered` = written on the recipient socket (or its
  mailbox), `read` = injected into the recipient session, `answered` = an
  explicit `mesh_reply` arrived. `expired` explicitly says late replies are
  still delivered. Never a completion.
- **Rooms & roles** — presence per room, `member` / `observer` roles,
  declarative policy (allow/deny lists, `force` authorization, rate limits).
- **Offline mailbox** — per-alias queue (cap 100, TTL 1 h) flushed at the next
  hello; senders get the honest `queued_offline` status.
- **Broadcast & reply variants** — `broadcast: true` fans out to a whole
  room (honest `deliveredCount/totalCount`), `mesh_reply` supports
  `replyAll` and targeted `to:` replies.
- **Group orchestration** — `mesh_wait_all` + launch mode (`awaitReply: true,
  block: false`): send a mission burst, then get ONE honest group verdict
  (who answered with the answer, who is missing). No sleep, no polling.
- **Inbound batching** — bursts are held while the agent is busy (long tool
  call) and injected as ONE batched message; live preview entries show the
  burst in real time while it happens (zero LLM tokens).
- **Per-agent colors** — every alias gets a stable color; messages, batches
  and live entries render inside the pi custom-message box with the sender's
  color, so agents are recognizable at a glance.
- **Read receipts & activity** — `mesh_status` shows who read your messages
  and who is `● working` / `○ idle` / `✕ stuck` (announced turn state + idle
  heuristic), plus a `likely done` summary.
- **File reservations** — claim repo paths before editing; other agents'
  `edit`/`write` calls on those paths are blocked with the holder's name.
  Reservations live with the connection and expire via TTL.
- **Identity persistence** — alias, rooms and reservations survive `/reload`
  (one file per pi session, never overwritten); `/mesh new` and pi `fork`
  hand the identity over; `/mesh reset` factory-resets in place.
- **Multi-machine** — TCP/TLS broker with a shared token; everything works
  unchanged across machines (VPS, LAN, Tailscale…).
- **Hash-only ledger** — durable history with bodies never stored, plus an
  opt-in redacted transcript. Zero loops: rate caps, anti-duplicate window,
  self-send block, reply dedup, ack-of-ack protection.

## Install

**As a Pi package** (recommended — the extension auto-loads):

```bash
pi install npm:pi-mesh-extension
```

**From source:**

```bash
git clone git@github.com:cgarrot/pi-mesh.git
cd pi-mesh
npm install
npm run build
```

Pi auto-loads the project extension. Open **two Pi sessions** in this
directory (each session gets its own alias):

```bash
# session 1            # session 2
pi                      pi
> /mesh alias           > /mesh alias
# → @agent-a1b2c3       # → @agent-d4e5f6
```

Then, in session 1 (tool call by the agent, or ask it):

```
mesh_send { "to": "agent-d4e5f6", "message": "hello from A" }
# → "delivered m_lxyz_ab12cd34"
```

Session 2 receives `[mesh] @agent-a1b2c3 (room default, normal, 14:32:05)
hello from A` as a follow-up turn and answers with
`mesh_reply { "msgId": "m_lxyz_ab12cd34", "message": "hi A" }`.

The broker **auto-spawns** on first use (lockfile in `$TMPDIR/mesh-<uid>/`).
No daemon management needed. Try `npm run smoke` for a full headless demo
(2 clients, mailbox, broker-kill recovery).

## Tools (Pi extension)

| tool | params | returns (honest one-liner + `details`) |
|---|---|---|
| `mesh_send` | `to?`, `message`, `room?`, `broadcast?`, `priority?`, `reason?`, `awaitReply?`, `block?`, `timeoutMs?`, `refs?` | `delivered` / `queued_offline` / `reply: …` / `expired` / `blocked: …` |
| `mesh_reply` | `msgId`, `message`, `replyAll?`, `to?`, `refs?` | `delivered` or `blocked: reply_without_target` |
| `mesh_wait_all` | `timeoutMs?` | block the turn until every awaited mission is answered (or timeout) — group verdict: who answered (with the answer), who is missing |
| `mesh_status` | `room?`, `all?` | live broker snapshot — peers sharing a room, per-peer version (`⚠` on skew), turn state (`● working / ○ idle / ✕ stuck`), `likely done` summary, read receipts, missions, broker counters |
| `mesh_ledger` | `limit?`, `from?`, `to?`, `room?`, `event?` | durable **hash-only** history — bodies never stored, survives restarts |
| `mesh_history` | `limit?`, `withBodies?` | local **memory ring** (debug — never the ledger) |
| `mesh_reserve` | `paths`, `reason?` | reserve files/dirs — peers' `edit`/`write` get blocked on them |
| `mesh_release` | `paths?` (omit = all) | release reservations, peers notified immediately |

**The orchestrator pattern** (injected in every session's identity context
and in the bundled skill):

1. Launch the burst: `mesh_send(..., awaitReply: true, block: false)` per
   mission — each returns `delivered` immediately, the mission stays tracked
   in the background (reminders, expiry, answer capture).
2. One `mesh_wait_all` for the group verdict — fast answers that arrived
   before the call are included; already-verdict'd missions are never
   re-listed. The verdict is ALSO rendered in the conversation as a colored
   entry: every line with the answering agent's color as the full-width
   background and readable neutral text (display-only, zero LLM tokens).
3. Re-send ONLY to the missing (`✗ NOT ANSWERED`). Never poll with
   `mesh_history`.

**Delivery modes** — `normal` → followUp · `urgent` → steer (interrupts the
current reflection) · `force` → controlled abort of the recipient's turn +
delivery once it settles (requires a `reason`, hashed, never persisted).
Replies always steer. Reply-à-reply (ack-of-ack chains) is delivered as
followUp with an INFO ONLY label — the LLM decides whether it matters.
Reminders arrive with an explicit "reply due for msgId" instruction.

**Read receipts** — when a message is injected into a session, the client
sends a `read` frame back to the sender; `mesh_status` shows
`reads: m_xxx → @agent-2 at 10:22`. This completes the honest-status
promise: `delivered ≠ read ≠ answered`.

## CLI (debug/admin)

```bash
node dist/src/cli/mesh.js broker start|stop|status
node dist/src/cli/mesh.js peers [--room R]     # with per-peer versions
node dist/src/cli/mesh.js send <alias> "text" [--room R] [--await] [--timeout MS]
node dist/src/cli/mesh.js tail                 # follows the local hash-only ledger
node dist/src/cli/mesh.js doctor               # socket? lock stale? pid? protocol?
```

## Configuration

`<cwd>/.mesh/config.json` (all optional):

```jsonc
{ "alias": "alice", "rooms": ["default"], "transcript": false,
  "mailboxCap": 100, "mailboxTtlMs": 3600000, "ledgerMaxBytes": 5242880,
  "activityIdleMs": 120000, "activityStuckMs": 900000, "reservationTtlMs": 0,
  "inboundBatchMs": 250, "inboundBatchMaxHoldMs": 30000 }
```

`.mesh/policy.json` (declarative governance, evaluated at send time):

```jsonc
{ "allow": [{ "from": "*", "to": "*", "room": "*" }],
  "deny":  [{ "from": "observer-*", "to": "*" }],
  "forceAllowedFrom": ["lead"],
  "rateLimits": { "msgPerMin": 30, "urgentPerMin": 15, "forcePerMin": 1 } }
```

Env overrides: `MESH_ALIAS`, `MESH_ROOMS`, `MESH_RUNTIME_DIR`,
`MESH_STATE_DIR`, `MESH_BROKER_URL`, `MESH_BROKER_TOKEN`, `MESH_LISTEN`,
`MESH_TLS_CERT/KEY/CA`, `MESH_TLS_INSECURE`, `MESH_MAX_FRAME_BYTES`,
`MESH_MAILBOX_CAP`, `MESH_MAILBOX_TTL_MS`, `MESH_TRANSCRIPT=1`,
`MESH_ACTIVITY_IDLE_MS`, `MESH_ACTIVITY_STUCK_MS`,
`MESH_RESERVATION_TTL_MS`, `MESH_INBOUND_BATCH_MS`,
`MESH_INBOUND_BATCH_MAX_HOLD_MS`, `MESH_POLICY`.

**Commands** — `/mesh status [room] · join <room> [as <alias>] [observer] ·
leave <room> · alias [<new-alias>] · new [--history] · reset · log [on|off] ·
ping <alias> · broker · help`.

- `/mesh join ops as agent-1` claims the alias `agent-1` and joins room
  `ops` in one step (live rename, rooms + reservations re-declared).
- `/mesh new [--history]` opens a fresh pi session like `/new` but hands
  over the mesh identity (alias, rooms, reservations; `--history` also
  transfers the last 30 mesh frames as context). Stale handoffs expire
  after 15 min.
- `/mesh reset` factory-resets the identity of the CURRENT session (fresh
  alias, default rooms, no reservations) without leaving it; `/reload`
  preserves the identity.
- **Identity survives `/reload`**: alias, rooms and reservations are
  persisted in `<stateDir>/identity-<sessionId>.json` — one file per pi
  session, stable across reloads, sessions sharing a stateDir never
  overwrite each other. Stale persisted reservations older than 24 h are
  dropped at load; if a crashed session still holds the alias, the client
  falls back to a random one (notified + persisted) instead of looping.
- **HUD**: a live widget above the editor shows the connection dot, rooms,
  peers with per-agent colors and turn-state markers (`●`/`○`/`✕`),
  pending awaits, transcript state and the last inbound preview.
- `/mesh broker` reports the version, session file size and compaction
  count, with a `/mesh new` hint past 15 MB.

The **`mesh-coordination` skill** (skills/mesh-coordination) is bundled in
the package: a protocol guide for agents (reply once per msgId, expired ≠
lost, reservation etiquette, the launch → wait_all rhythm) — loaded on
demand like any pi skill.

## Multi-machine

The mesh is loopback-only by default; to connect several machines (a VPS, a
LAN PC, …) start the broker on ONE machine in **TCP mode** with a shared
token, and point the other machines' clients at it:

```bash
# Machine A (broker + agents) — open the port in the firewall
MESH_LISTEN=tcp://0.0.0.0:8712 MESH_BROKER_TOKEN=change-me pi

# Machine B (clients only — no local broker is spawned)
MESH_BROKER_URL=tcp://<machine-A>:8712 MESH_BROKER_TOKEN=change-me pi
```

- `tcp://` for LAN/VPN (Tailscale/ZeroTier/WireGuard recommended),
  `tls://` for a VPS (set `MESH_TLS_CERT`/`MESH_TLS_KEY` on the broker;
  clients may set `MESH_TLS_CA`, or `MESH_TLS_INSECURE=1` for self-signed —
  dev only).
- The token is **required** for tcp/tls listens; a hello without it is
  refused (`invalid_token`, token travels hashed).
- Everything works unchanged across machines: rooms, broadcast, read
  receipts, mailbox, reservations, turn state (state lives in the broker).
  `mesh doctor` checks the endpoint/auth on any machine.
- Aliases must stay **unique mesh-wide**: prefix per machine
  (`MESH_ALIAS=pcB-agent-2`). Identities/ledgers stay local to each
  machine; reservations protect the same repo paths when both machines
  share the same git checkout (always reserve repo-relative paths).

## Reliability notes

- **Broker is stateless**: kill it any time, clients re-hello and re-declare
  rooms + reservations; it re-spawns automatically.
- **Mailbox is volatile**: a broker restart loses queued offline messages;
  senders always get the honest `queued_offline` status.
- **Zero loops**: rate caps (client and broker), anti-duplicate send window,
  self-send block, reply dedup (first answer wins, exact re-sends dropped),
  reply-à-reply protection, `force` requires a reason.
- **No body is ever persisted** outside the opt-in transcript: the ledger is
  hash-only with a fail-closed forbidden-key scan; `identity-pending.json`
  (the `/mesh new --history` handover) is the only opt-in body staging,
  deleted after consumption.
- **Bounds**: frame 64 KiB, body 32 KiB, mailbox 100/1 h, reminds ≤ 2,
  16 rooms/peer, 64 peers/room — every bound is a named constant.
- **Broker down** → tools answer `blocked{broker_unavailable}`, never crash.
- **Turn state** is announced by each session (busy on the first tool call,
  idle when the run settles) and shared with the room; peers without
  announcements fall back to the idle/stuck heuristic.

## Platform notes

- **Windows**: AF_UNIX sockets are unavailable on win32 (`listen` throws
  `EACCES`), so the broker endpoint falls back to a **named pipe**
  (`\\.\pipe\mesh-<hash>-broker`). Everything else is unchanged; the full
  test suite + smoke pass on Windows.

## Known limitations

- Broker restarts lose rooms/mailbox (clients re-declare on hello).
- One shared token for the whole mesh on TCP/TLS — no per-alias
  authorization yet (policy covers `force` and deny lists).
- Aliases are unique mesh-wide by convention (prefix per machine) — no
  cross-machine collision detection beyond the broker's live check.
- The broker is a single process — no clustering or failover.

## Development

```bash
npm run build   # strict tsc (ESM, NodeNext)
npm test        # build + node --test dist/test/*.test.js (286 tests)
npm run smoke   # E2E without Pi: broker + 2 headless clients
```

CI runs the full suite on Node 24 (GitHub Actions); the suite is verified on
Node 20 as well. Publishing is automatic on `v*` tags (see
`.github/workflows/release.yml`, needs the `NPM_TOKEN` secret):

```bash
npm version patch && git push && git push --tags
```

Layout: `src/protocol` (frames, envelope) · `src/broker` (server, rooms,
mailbox, ratelimit, policy) · `src/client` (MeshClient, pending, reconnect) ·
`src/extension` (Pi adapter: tools, commands, inbound, guards, ledger,
transcript) · `src/cli` · `test/` · `scripts/mesh-smoke.mjs`.

## License

MIT — see [LICENSE](LICENSE).
