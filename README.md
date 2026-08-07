# pi-mesh — live agent-to-agent communication for Pi

**pi-mesh** is a standalone **Pi extension** for live agent-to-agent
communication. Local Pi agents talk to each other in < 50 ms through a tiny
local broker (unix socket, NDJSON frames, protocol `mesh.v1`). Presence is
**observed** (live sockets), statuses are **honest** (`delivered` ≠ read ≠
answered), and the durable ledger is **hash-only**. Zero runtime dependencies;
Node ≥ 22.

This repo is the mesh-only slice of the harness it was extracted from: no
guild, no worklist, no orchestration — just the plugin you drop into any Pi
project and use on any machine.

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

## Install / use on another machine

**As a Pi package** (recommended — the extension auto-loads):

```bash
pi install npm:pi-mesh
# or from git, pinned to a release tag
pi install git:github.com/cgarrot/pi-mesh@v0.1.0
```

**From source (clone and run):**

```bash
git clone git@github.com:cgarrot/pi-mesh.git
cd pi-mesh
npm install
npm run build          # tsc → dist/ (build needed for CLI + tests; the Pi
                       # extension itself loads from src/ directly)
```

Pi auto-loads the project extension from `.pi/extensions/mesh/`. Open **two Pi
sessions** in this directory (each session gets its own alias):

```bash
# session 1
pi
> /mesh alias            # → @agent-a1b2c3 (or set MESH_ALIAS=alice)
# session 2
pi
> /mesh alias            # → @agent-d4e5f6
```

Then, in session 1 (tool call by the agent, or ask it):

```
mesh_send { "to": "agent-d4e5f6", "message": "hello from A" }
# → "delivered m_lxyz_ab12cd34"
```

Session 2 receives `[mesh] @agent-a1b2c3 (room default, normal) hello from A`
as a follow-up turn. It can answer with
`mesh_reply { "msgId": "m_lxyz_ab12cd34", "message": "hi A" }`.

The broker **auto-spawns** on first use (lockfile in `$TMPDIR/mesh-<uid>/`). No
daemon management needed. Try `npm run smoke` for a full headless demo
(2 clients, mailbox, broker-kill recovery).

> Drop the extension into another Pi project: copy `extensions/mesh/` and the
> `src/` tree into that project, or `pi install` this package — the `mesh_*`
> tools + `/mesh` command are available. The extension is a thin adapter over
> the client — everything else is self-contained Node.

## Releases & publishing

- Versioning follows semver from `package.json` (`v0.1.0` = tag + npm version).
- To publish a new release: `npm version patch|minor|major && git push --tags
  && npm publish`. `prepublishOnly` runs the full build + test suite first.
- The package is published as `pi-mesh` on npmjs.org (`publishConfig.access`
  is public) and is a Pi package (`pi` manifest + `pi-package` keyword), so
  `pi install npm:pi-mesh` works on any machine.

## Tools (Pi extension)

| tool | params | returns (honest one-liner + `details`) |
|---|---|---|
| `mesh_send` | `to`, `message`, `room?`, `priority?`, `reason?`, `awaitReply?`, `timeoutMs?`, `refs?` | `delivered` / `queued_offline` / `reply: …` / `expired` / `blocked: …` |
| `mesh_reply` | `msgId`, `message`, `refs?` | `delivered` or `blocked: reply_without_target` |
| `mesh_status` | `room?` | live broker snapshot (peers, rooms) |
| `mesh_history` | `limit?`, `withBodies?` | local **memory ring** (never the ledger) |

Priorities: `normal` → followUp · `urgent` → steer · `force` → controlled abort
(when the recipient is busy) + steer. `force` requires `reason` (hashed into
`reasonHash`, never persisted) and is governed by `policy.forceAllowedFrom`.

Command: `/mesh status [room] · join <room> [observer] · leave <room> · alias ·
log [on|off] · ping <alias> · broker · help`.

**HUD**: a live widget above the editor shows mesh state at a glance —
`mesh ● alice @default,ops · peers: bob,carol(+3) · pend:2 · tx:on` — with the
connection dot (● online / ◐ connecting / ○ offline), rooms, online peers,
awaitReply pendings, transcript state, failure counters (only when > 0) and the
last activity (< 90 s, memory-only preview). A compact `mesh:N` / `mesh:off`
sits in the footer status. Run `/reload` after changing the extension to
refresh it.

## CLI (debug/admin)

```bash
node dist/src/cli/mesh.js broker start|stop|status
node dist/src/cli/mesh.js peers [--room R]
node dist/src/cli/mesh.js send <alias> "text" [--room R] [--await] [--timeout MS]
node dist/src/cli/mesh.js tail        # follows the local hash-only ledger
node dist/src/cli/mesh.js doctor      # socket? lock stale? pid? protocol?
```

## Configuration

`<cwd>/.mesh/config.json` (all optional):

```jsonc
{ "alias": "alice", "rooms": ["default"], "transcript": false,
  "mailboxCap": 100, "mailboxTtlMs": 3600000, "ledgerMaxBytes": 5242880 }
```

`.mesh/policy.json` (declarative governance, evaluated at send time):

```jsonc
{ "allow": [{ "from": "*", "to": "*", "room": "*" }],
  "deny":  [{ "from": "observer-*", "to": "*" }],
  "forceAllowedFrom": ["lead"],
  "rateLimits": { "msgPerMin": 30, "urgentPerMin": 5, "forcePerMin": 1 } }
```

Env overrides: `MESH_ALIAS`, `MESH_ROOMS`, `MESH_RUNTIME_DIR`,
`MESH_STATE_DIR`, `MESH_MAX_FRAME_BYTES`, `MESH_MAILBOX_CAP`,
`MESH_MAILBOX_TTL_MS`, `MESH_TRANSCRIPT=1`, `MESH_POLICY`.

## Invariants (I1–I10)

- **I1** no message body is ever persisted outside the opt-in transcript;
  the ledger is hash-only (`bodyStored:false`, fail-closed forbidden-key scan).
- **I2** presence = live sockets. No registry files, no sweeps of files.
- **I3** one alias = one connection; `alias_taken` refused in the same tick.
- **I4** `delivered` = written on the recipient socket (or its mailbox) —
  **after** the broker ack, never before (C5). Never a completion.
- **I5** replies exist only via explicit `mesh_reply` (strict `replyTo === msgId`).
- **I6** the broker is stateless: kill it any time, clients re-`hello`.
- **I7** zero loops: rate caps + anti-duplicate window + self-send block.
- **I8** every bound is a named constant (frame 64 KiB, body 32 KiB, mailbox
  100/1 h, reminds ≤ 2, 16 rooms/peer, …).
- **I9** `protocol/`, `broker/`, `client/` import nothing from Pi; the
  extension is a thin adapter with local `pi-types.ts`.
- **I10** broker down → tools answer `blocked{broker_unavailable}`, never crash.

## Known limitations (v1)

- **Mailbox is volatile**: broker restart loses queued offline messages.
  Senders always get the honest `queued_offline` status.
- **Loopback only**: unix socket on one machine, no network, no auth/encryption.
- One alias per Pi session; no in-flight alias change.
- No room broadcast: messages are strictly **unicast** (`to=<alias>` required).
  A room carries presence + authorization only (roles `member`/`observer`,
  `policy`) — sending "into a room" only touches the explicit recipient.

## Development

```bash
npm run build   # strict tsc (ESM, NodeNext)
npm test        # build + node --test dist/test/*.test.js
npm run smoke   # E2E without Pi: broker + 2 headless clients
```

Layout: `src/protocol` (frames, envelope) · `src/broker` (server, rooms,
mailbox, ratelimit, policy) · `src/client` (MeshClient, pending, reconnect) ·
`src/extension` (Pi adapter: tools, commands, inbound, guards, ledger,
transcript) · `src/cli` · `test/` · `scripts/mesh-smoke.mjs`.
