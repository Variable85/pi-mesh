---
name: mesh-coordination
description: Guide for using the multi-agent mesh (pi-mesh) — messaging, replies, reservations, anti-loop rules. Read it when you coordinate with other agents or answer a mesh message.
---

# Mesh coordination (pi-mesh)

You are connected to a local mesh of pi agents. Rules and reflexes to avoid
duplicates, loops and confusion.

## Get oriented

- `mesh_status` — who is online, in which room, **status** (`○idle`,
  `✕stuck` = idle long with reservations), and read receipts (`reads:`).
- `mesh_history` — recent exchanges (memory).
- `mesh_ledger` — durable history (hash-only): filter by
  `from/to/room/event`. **Use it to verify before re-sending.**

## Sending

- `mesh_send { to: "agent-X", message }` — direct message (shared room
  required).
- `mesh_send { broadcast: true, room: "cs-room", message }` — announce to the
  whole room (the result reports `delivered N/M`).
- `awaitReply: true` waits for an answer (30 min default timeout).

## Replying (GOLDEN RULES)

1. **Always `mesh_reply { msgId, message }` with the EXACT msgId received** —
   never answer with a new `mesh_send`.
2. **One answer per msgId.** If the result says `⚠️ already replied to this
   msgId recently` — you ALREADY replied: do not insist, the answer is gone
   (`delivered`).
3. **`replyAll: true`** to answer the WHOLE room of the original message
   (e.g. "mission done" visible to everyone).
4. **`to: "agent-Y"`** to forward the answer to another agent than the
   sender.
5. A **reminder** says *"IGNORE this reminder if you ALREADY replied to this
   msgId"*: if you already replied, **ignore it**.
6. **NEVER reply to a reply** (reply-à-reply). Replies to replies arrive with
   the **INFO ONLY** label: read them (a proof or a correction can be
   important), but **never answer with an acknowledgment** — to react
   (question, correction), send a **new message** (`mesh_send`), not a reply.

## Launch a burst, then wait_all (delay-free, general pattern)

1. **Launch** every mission with `awaitReply: true, block: false` — the
   tool returns `delivered` immediately and the mission stays tracked in
   the background (reminds, expiry, answers). A burst of N missions costs
   one turn, not N blocking calls.
2. **`mesh_wait_all { timeoutMs }`** — the turn is suspended INSIDE the
   tool call (no sleep, no polling). It returns the honest group verdict:
   who answered (with the answer), who is missing. Fast answers that
   arrived before the call are included; already-verdict'd missions are
   not re-listed.
3. Re-send ONLY to the missing (`✗ NOT ANSWERED`).
- Never poll with `mesh_history`/`mesh_status` to check who answered —
  that is what `mesh_wait_all` is for.
- `block: false` without `awaitReply` is refused; `awaitReply` without
  `block: false` blocks the turn until that one reply (fine for a single
  awaited send).

## Orchestrator rhythm (delay-free)

- **NEVER `sleep` while awaiting replies.** A `sleep` is a long tool call:
  incoming messages stay queued until it finishes, then arrive in one big
  burst. Instead: END YOUR TURN — inbound replies trigger a new turn
  automatically (triggerTurn), delivered between tool calls.
- **Process replies as they arrive**, one at a time. Do not batch-answer.
- **`awaitReply: true`** resolves each mission as its answer lands — keep
  the loop tight: send, treat the reply, move on.
- **NEVER send acknowledgments** ("received", "thanks", "ok"). An ack
  generates an ack-of-ack and burns tokens (INFO ONLY replies are already
  labelled; read them, do not answer them).

## Anti-loops (orchestrator)

- **`expired` ≠ lost.** A late answer is delivered and injected
  automatically. Before re-sending a mission: check `mesh_ledger` or
  `mesh_history` to see whether the answer already arrived.
- Do not re-assign an already delivered mission: check the register
  (MISSIONS.md / work folder) AND `mesh_ledger` first.
- Agents can be `✕stuck` (idle with reservations): contact them via
  `mesh_send` before concluding they are lost.

## File reservations

- **`mesh_reserve { paths: [...] }` BEFORE editing** a shared file;
  `mesh_release` as soon as you are done.
- If an `edit`/`write` is **blocked**: another agent reserved the path —
  `mesh_send` the owner to coordinate, do not force it.
- Reservations disappear on disconnect (and after the configured TTL).

## Honest statuses

`delivered` = written on the recipient's socket (≠ read ≠ answered).
`reads:` in `mesh_status` shows who has taken knowledge of your messages.
