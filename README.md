# pi-mesh — live agent-to-agent communication for Pi

![pi-mesh preview](https://raw.githubusercontent.com/cgarrot/pi-mesh/main/assets/preview.jpg)

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
pi install npm:pi-mesh-extension
# or from git, pinned to a release tag
pi install git:github.com/cgarrot/pi-mesh@v0.1.3
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

> Drop the extension into another Pi project: copy `index.ts` and the `src/`
> tree into that project, or `pi install` this package — the `mesh_*` tools +
> `/mesh` command are available. The extension is a thin adapter over the
> client — everything else is self-contained Node.

## Releases & publishing

- Versioning follows semver from `package.json` (`v0.1.0` = tag + npm version).
- The `Release` GitHub Action publishes to npm automatically on `v*` tags
  (requires the `NPM_TOKEN` repository secret):
  `npm version patch|minor|major && git push && git push --tags`.
  `prepublishOnly` runs the full build + test suite before every publish.
- The package is published as `pi-mesh-extension` on npmjs.org
  (`publishConfig.access` is public; the plain `pi-mesh` name is already taken
  on npm by another project) and is a Pi package (`pi` manifest +
  `pi-package` keyword), so `pi install npm:pi-mesh-extension` works on any
  machine and the package appears in the pi.dev gallery automatically.

## Tools (Pi extension)

| tool | params | returns (honest one-liner + `details`) |
|---|---|---|
| `mesh_send` | `to?`, `message`, `room?`, `broadcast?`, `priority?`, `reason?`, `awaitReply?`, `timeoutMs?`, `refs?` | `delivered` / `queued_offline` / `reply: …` / `expired` / `blocked: …` |
| `mesh_reply` | `msgId`, `message`, `replyAll?`, `to?`, `refs?` | `delivered` or `blocked: reply_without_target` |
| `mesh_status` | `room?`, `all?` | live broker snapshot — only peers **sharing a room** (D29), with **activity status** (`○idle` / `✕stuck` when idle long with reservations, D32) and **read receipts** (`reads:` — D34); `all: true` for the whole mesh |
| `mesh_wait_all` | `timeoutMs?` | block the turn until every awaited mission is answered (or timeout) — honest group summary: who answered, who is missing (D42) |
| `mesh_ledger` | `limit?`, `from?`, `to?`, `room?`, `event?` | durable **hash-only** history (I1) — bodies never stored, survives restarts (D36) |
| `mesh_history` | `limit?`, `withBodies?` | local **memory ring** (never the ledger) |
| `mesh_reserve` | `paths`, `reason?` | reserve files/dirs — peers' `edit`/`write` get blocked on them |
| `mesh_release` | `paths?` (omit = all) | release reservations, peers notified immediately |

**Read receipts (D34)**: when a message is injected into a session, the
client sends a `read` frame back to the sender — `mesh_status` then shows
`reads: m_xxx → @agent-2 at 10:22`. This completes the honest-status
promise: `delivered ≠ read ≠ answered`.

**Activity status (D32)**: the broker exposes each peer's last activity
(heartbeats/tool frames); `mesh_status` and the HUD mark `○idle` after
`activityIdleMs` (2 min) and `✕stuck` when idle past `activityStuckMs`
(15 min) while holding reservations — orchestrators can spot blocked
agents. Config: `activityIdleMs`, `activityStuckMs`.

**Reservation TTL (D33)**: `reservationTtlMs` (default `0` = unlimited,
I11) expires stale claims — the broker sweeps and notifies peers, and
`findConflict` ignores expired reservations.

**Fork identity (D35)**: a pi `fork` now hands the mesh identity over
(alias, rooms, reservations) like `/mesh new` — the forked session is not
anonymous anymore.

**Reply-à-reply info-only (D39)**: a reply whose target is itself a reply
(ack-of-ack chains) is still delivered, but as **followUp** (no
interruption) with an **INFO ONLY label** — the LLM decides whether the
content is worth reacting to (a proof, a correction), and the label says
never to answer with an ack and to use `mesh_send` for reactions.
Replies are rate-limited (30/min msg bucket) as a spam safety net, and
the "already replied" warning flags re-answers.

**Reply handling (D25)**: replies are deduped — only the FIRST answer to a
given msgId reaches the session (via `awaitReply` or as an injected orphan);
later duplicates (agents re-answering on reminds or after re-sends) are
dropped silently, so the orchestrator never re-processes an answer it already
handled. Replies are delivered with **steer** (they interrupt the current
reflection) instead of queuing until the turn ends. `awaitReply` defaults to
30 min (was 10) — long missions no longer "expire" while agents are still
working — and an `expired` result explicitly says late replies are still
delivered. Re-replying to the same msgId within 10 min returns a warning
(`already_replied`) instead of silently duplicating.

**Broadcast & reply variants (D24)**: `mesh_send` with `broadcast: true` fans
a message out to every member of `room` (omitting `to`), and the honest ack
reports `deliveredCount/totalCount`. `mesh_reply` keeps strict 1:1 correlation
by default, and adds two variants: `replyAll: true` answers the WHOLE room of
the original message (counts in the ack), and `to: <alias>` targets another
member than the original sender (e.g. bounce a mission to a colleague). The
inbound format marks fan-outs: `(room ops, normal, broadcast)` / `reply-all`.

Priorities: `normal` → followUp · `urgent` → steer · `force` → controlled abort
(when the recipient is busy) + **delivery once the aborted turn settles**. `force`
requires `reason` (hashed into `reasonHash`, never persisted) and is governed by
`policy.forceAllowedFrom`.

**File reservations**: claim paths before touching them — a trailing `/`
reserves a whole subtree (`web/tools/`), anything else is exact. While a peer
holds a reservation, other agents' `edit`/`write` tool calls on those paths are
blocked with a message naming the holder + reason, and they are told to
coordinate via `mesh_send`. Reservations **live with the connection** (like
presence): a disconnected peer's reservations vanish automatically, and every
change is broadcast to all peers in < 50 ms.

Command: `/mesh status [room] · join <room> [as <alias>] [observer] ·
leave <room> · alias [<new-alias>] · log [on|off] · ping <alias> · broker ·
help`. `join … as <alias>` renames this session live (re-hello under the new
alias, rooms + reservations re-declared) and then joins the room — so a
session can claim `agent-1` at any time, not just at startup.

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

> **I1 note**: `/mesh new --history` stages up to 30 message bodies in
> `identity-pending.json` (15 min TTL, deleted after consumption) — an
> explicit opt-in handover, the only body persistence outside the opt-in
> transcript.

**`/mesh new [--history]` (D30)** opens a fresh pi session like pi's `/new`
(blank conversation) but HANDS OVER the mesh identity: alias, rooms and
reservations are staged and consumed by the new session (the broker may
briefly see alias_taken while the old session closes — the retry backoff
handles it). `--history` also transfers the last 30 mesh frames as context.
Stale handoffs expire after 15 min.

**`/mesh reset` (D28)** factory-resets the mesh identity of the CURRENT pi
session — like `/new` (fresh random alias, default rooms, no reservations,
identity file wiped) but WITHOUT leaving the session, while `/reload`
preserves the identity. Useful to detach a session from a project mesh.

Aliases can also be set at runtime: `/mesh join ops as agent-1` claims the
alias `agent-1` and joins room `ops` in one step, and
`/mesh alias <new-alias>` renames at any time. An alias already held by a
live peer is refused (`alias_taken`) and the session keeps its previous
identity.

**Identity survives `/reload`**: alias, rooms and reservations are persisted
in `<stateDir>/identity-<sessionId>.json` — one file per pi session (stable
across extension reloads, and multiple sessions sharing a stateDir never
overwrite each other). After a reload the agent comes back with the exact same
mesh identity — no more random alias, lost rooms or vanished reservations.
Stale persisted reservations older than 24 h are dropped at load, and if a
crashed session still holds the alias, the client falls back to a random one
(notify + persisted) instead of looping.

`.mesh/policy.json` (declarative governance, evaluated at send time):

```jsonc
{ "allow": [{ "from": "*", "to": "*", "room": "*" }],
  "deny":  [{ "from": "observer-*", "to": "*" }],
  "forceAllowedFrom": ["lead"],
  "rateLimits": { "msgPerMin": 30, "urgentPerMin": 5, "forcePerMin": 1 } }
```

The **`mesh-coordination` skill** (skills/mesh-coordination) is bundled in
the package: a protocol guide for agents (reply once per msgId, expired ≠
lost, reservation etiquette) — loaded on demand like any pi skill.

Env overrides: `MESH_ALIAS`, `MESH_ROOMS`, `MESH_RUNTIME_DIR`,
`MESH_STATE_DIR`, `MESH_MAX_FRAME_BYTES`, `MESH_MAILBOX_CAP`,
`MESH_MAILBOX_TTL_MS`, `MESH_TRANSCRIPT=1`, `MESH_POLICY`.

## Multi-machine (D37)

The mesh is loopback-only by default; to connect several machines (a VPS, a
LAN PC, …) start the broker on ONE machine in **TCP mode** with a shared
token, and point the other machines' clients at it:

```bash
# Machine A (broker + agents) — open the port in the firewall
MESH_LISTEN=tcp://0.0.0.0:8712 MESH_BROKER_TOKEN=mon-secret pi

# Machine B (clients only — no local broker is spawned)
MESH_BROKER_URL=tcp://<ip-de-A>:8712 MESH_BROKER_TOKEN=mon-secret pi
```

- `tcp://` for LAN/VPN (Tailscale/ZeroTier/WireGuard recommended), `tls://`
  for a VPS (set `MESH_TLS_CERT`/`MESH_TLS_KEY` on the broker; clients may
  set `MESH_TLS_CA`, or `MESH_TLS_INSECURE=1` for self-signed — dev only).
- **The token is REQUIRED** for tcp/tls listens; hello without it →
  `invalid_token` (the token travels hashed, sha256).
- Everything works unchanged across machines: rooms, broadcast, read
  receipts, mailbox, reservations, activity status (state lives in the
  broker). Use `mesh doctor` to check the endpoint/auth on any machine.
- Aliases must stay **unique mesh-wide**: prefix per machine
  (`MESH_ALIAS=pcB-agent-2`). Identities/ledgers stay local to each
  machine; reservations protect the same repo paths when both machines
  share the same git checkout (always reserve repo-relative paths).

**Inbound batching (D40)**: messages are **held while the agent is busy**
(a long tool call like a `sleep` runs) and flushed as **ONE batched
message** when the busy period ends (`tool_result`) or the agent turns
idle — so a whole burst lands in the conversation at once, one turn
instead of one turn per message. `inboundBatchMs` (250 ms, 0 = off) is
the idle window; `inboundBatchMaxHoldMs` (30 s) is the safety cap while
busy. Delivery: steer if the batch contains a reply/urgent, followUp
otherwise; `force` and reminders always bypass.

**Group waiting (D42)**: `mesh_wait_all` replaces sleep-while-waiting —
the turn is suspended in the tool call until all `awaitReply` missions are
answered (or the timeout), then returns who answered (with answers) and who
is missing. `mesh_status` lists `missions: ✓ answered / ✗ waiting`.

**Observability (M1/M2)**: the hello carries the extension version —
`mesh_status` and `mesh peers` show every peer's version with a ⚠ when it
differs from the broker's (stale sessions at a glance). `mesh_status`
also shows the broker counters (relayed/refused/mailbox). Inbound
messages now carry the local arrival time in their prefix (HH:MM:SS).

**Boxed rendering (D45)**: mesh messages (simple, batches, live entries)
are rendered INSIDE the pi custom-message box again — background
customMessageBg (the purple frame), label `[mesh-inbound]`, padding —
while keeping the per-agent colors.

**Hardening (D44)**: missions never stay "waiting" forever (failed/expired
statuses in `mesh_status`), bounded mission/inbox/receipt history, leave
broadcasts presence(offline), per-agent live-entry cooldown (1.5 s — a
burst shows one preview instead of flooding), HUD alias recoloring with
word boundaries, stale known aliases pruned by the broker, teardown-safe
batch flush.

**Per-agent colors + live view (D43)**: every alias gets a STABLE color
(hash → 12-color theme palette) used everywhere — messages, batches, live
entries and the HUD — so each agent is recognizable at a glance. While the
agent is busy (a sleep or long tool call), inbound frames are ALSO rendered
**live** in the conversation (`mesh-live` entries outside the LLM context,
zero tokens) — the burst is visible in real time, and the batched summary
arrives when the busy period ends.

**Colored rendering (D41)**: mesh messages in the conversation are
rendered with `pi-tui` — batch header in accent, sender aliases in
accent, instructions muted, long lines wrapped.

## Platform notes

- **Windows**: AF_UNIX sockets are unavailable on win32 (`listen` throws
  `EACCES`), so the broker endpoint falls back to a **named pipe**
  (`\\.\pipe\mesh-<hash>-broker`). Everything else is unchanged: the lock file
  is still a regular file, `mesh doctor` shows the resolved endpoint, and the
  full test suite + smoke pass on Windows.

## Invariants (I1–I11)

- **I1** no message body is ever persisted outside the opt-in transcript;
  the ledger is hash-only (`bodyStored:false`, fail-closed forbidden-key scan).
- **I2** presence = live sockets. No registry files, no sweeps of files.
- **I3** one alias = one connection; `alias_taken` refused in the same tick.
- **I4** `delivered` = written on the recipient socket (or its mailbox) —
  **after** the broker ack, never before (C5). Never a completion.
- **I5** replies exist only via explicit `mesh_reply` (strict `replyTo === msgId`).
- **I6** the broker is stateless: kill it any time, clients re-`hello`
  (reservations are re-declared in the hello frame).
- **I7** zero loops: rate caps + anti-duplicate window + self-send block.
- **I8** every bound is a named constant (frame 64 KiB, body 32 KiB, mailbox
  100/1 h, reminds ≤ 2, 16 rooms/peer, …).
- **I9** `protocol/`, `broker/`, `client/` import nothing from Pi; the
  extension is a thin adapter with local `pi-types.ts`.
- **I10** broker down → tools answer `blocked{broker_unavailable}`, never crash.
- **I11** file reservations live with the connection: declared at `hello`,
  broadcast on every change, gone when the peer disconnects (D21).
- **I12** identity persistence (D23): alias/rooms/reservations are stored per
  pi-sessionId in `<stateDir>/identity-<sessionId>.json` and re-declared on
  reload; sessions sharing a stateDir stay isolated (one file per session).

## Known limitations (v1)

- **Mailbox is volatile**: broker restart loses queued offline messages.
  Senders always get the honest `queued_offline` status.
- **Loopback only**: unix socket (named pipe on Windows) on one machine,
  no network, no auth/encryption.
- **Rooms are per-connection**: a peer in zero rooms cannot send/receive
  room messages until it joins one again (`/mesh join <room>`).
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
