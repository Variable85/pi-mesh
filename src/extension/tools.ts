// extension/tools.ts — the 4 mesh tools (§9.2): mesh_send, mesh_reply,
// mesh_status, mesh_history. Plain JSON Schema parameters (zero-dependency).
// Honest statuses: delivered ≠ read ≠ answered (I4). Offline → blocked (I10).
import { MeshClient, type SendResult } from "../client/client.js";
import type { MeshPriority } from "../protocol/envelope.js";
import { buildFrame, normalizeAlias } from "../protocol/envelope.js";
import { sha256 } from "../protocol/frames.js";
import {
  DEFAULT_AWAIT_REPLY_TIMEOUT_MS,
  DEFAULT_ROOM,
  MAX_AWAIT_REPLY_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REFS,
  MIN_AWAIT_REPLY_TIMEOUT_MS,
  TRANSCRIPT_RING_SIZE,
} from "../shared/config.js";
import type { MeshGuards } from "./guards.js";
import { LOOP_GUARD_WARNING } from "./guards.js";
import type { MeshLedger } from "./ledger.js";
import type { ExtensionAPI, SessionContext, ToolResult } from "./pi-types.js";
import { textResult } from "./pi-types.js";
import type { MeshTranscript } from "./transcript.js";

/** Shared per-session runtime, built at session_start (index.ts). */
export interface MeshRuntime {
  client: MeshClient;
  ledger: MeshLedger;
  transcript: MeshTranscript;
  guards: MeshGuards;
  ctx: SessionContext | null;
  stateDir: string;
  runtimeDir: string;
  startedAt: number;
  /** B1: inbound-path disk/injection failure counters (see index.ts). */
  ledgerFailures: number;
  transcriptFailures: number;
  injectionFailures: number;
}

export type GetRuntime = () => MeshRuntime | null;

const SEND_RESULT_SCHEMA = "mesh.send-result.v1";

function sendDetails(
  partial: Record<string, unknown>,
): Record<string, unknown> {
  return { schema: SEND_RESULT_SCHEMA, bodyStored: false, ...partial };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function resultText(res: SendResult): string {
  switch (res.status) {
    case "delivered":
      return `delivered ${res.msgId}`;
    case "queued_offline":
      return `queued_offline ${res.msgId}`;
    case "reply":
      return `reply ${res.msgId}: ${res.response}`;
    case "expired":
      return `expired ${res.msgId ?? ""}`;
    case "blocked":
      return `blocked: ${res.reason}`;
    case "error":
      return `error: ${res.reason}`;
  }
}

/** Best-effort ledger append — a ledger failure never crashes the session (I10). */
function safeLedger(rt: MeshRuntime, input: Parameters<MeshLedger["append"]>[0]): void {
  try {
    rt.ledger.append(input);
  } catch {
    // fail-closed throw is for forbidden keys; our records never contain them
  }
}

// ---------------------------------------------------------------- mesh_send

const MESH_SEND_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    to: { type: "string", description: "Target alias ('@' tolerated, case-insensitive)." },
    message: { type: "string", description: "Message body (1..32 KiB)." },
    room: { type: "string", description: "Room id (default: 'default')." },
    priority: {
      type: "string",
      enum: ["normal", "urgent", "force"],
      description: "normal→followUp, urgent→steer, force→abort+steer (requires reason).",
    },
    reason: {
      type: "string",
      description: "Required when priority=force. Hashed (reasonHash), never persisted.",
    },
    awaitReply: { type: "boolean", description: "Wait for an explicit mesh_reply (default false)." },
    timeoutMs: {
      type: "number",
      minimum: MIN_AWAIT_REPLY_TIMEOUT_MS,
      maximum: MAX_AWAIT_REPLY_TIMEOUT_MS,
      description: `awaitReply timeout in ms (default ${DEFAULT_AWAIT_REPLY_TIMEOUT_MS}).`,
    },
    refs: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_REFS,
      description: "Repo-relative reference paths (≤ 8).",
    },
  },
  required: ["to", "message"],
};

async function execMeshSend(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const toRaw = str(params.to);
  const message = str(params.message);
  if (toRaw === undefined || message === undefined) {
    return textResult("error: invalid_frame (to and message are required)", sendDetails({ status: "error", reason: "invalid_frame" }));
  }
  // A8: ledger records + tool details store the CANONICAL alias ('@Bob' → 'bob')
  // so ledger predicates are insensitive to how the model typed the alias.
  // Guards (checkSend) and client.send normalize idempotently; result text unchanged.
  const to = normalizeAlias(toRaw);
  const room = str(params.room) ?? DEFAULT_ROOM;
  const priority = (str(params.priority) ?? "normal") as MeshPriority;
  const reason = str(params.reason);
  const awaitReply = params.awaitReply === true;
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
  const refs = Array.isArray(params.refs)
    ? params.refs.filter((r): r is string => typeof r === "string")
    : undefined;
  const bodyHash = sha256(message);
  const reasonHash = priority === "force" && reason !== undefined ? sha256(reason) : undefined;

  // Guards (§9.4): self-send, duplicate window, client caps, observer.
  const guard = rt.guards.checkSend({ from: rt.client.alias, to, room, body: message, priority });
  if (!guard.ok) {
    safeLedger(rt, {
      event: "blocked", from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs, code: guard.reason,
    });
    return textResult(`blocked: ${guard.reason}`, sendDetails({ status: "blocked", reason: guard.reason, to, room, priority, bodyHash }));
  }

  if (!rt.client.isOnline()) {
    // I10: broker absent → tools answer blocked, never crash the session.
    try {
      await rt.client.connect();
    } catch {
      safeLedger(rt, { event: "blocked", from: rt.client.alias, to, room, priority, bodyHash, refs, code: "broker_unavailable" });
      return textResult("blocked: broker_unavailable", sendDetails({ status: "blocked", reason: "broker_unavailable", to, room, priority, bodyHash }));
    }
  }

  // transcript: outbound frame WITH body (redacted at record time) — opt-in only.
  if (rt.transcript.isEnabled()) {
    rt.transcript.record("out", buildFrame({ type: "msg", from: rt.client.alias, to, room, priority, body: message, refs }));
  }
  safeLedger(rt, { event: "sent", from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs });

  const res = await rt.client.send({ to, message, room, priority, reason, awaitReply, timeoutMs, refs });

  // C5: `delivered` is ledgered ONLY here — after the broker ack (client.send
  // resolves delivered exclusively post-ack).
  switch (res.status) {
    case "delivered":
      safeLedger(rt, { event: "delivered", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs });
      break;
    case "queued_offline":
      safeLedger(rt, { event: "queued_offline", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs });
      break;
    case "reply":
      safeLedger(rt, { event: "reply", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, refs, code: res.outputHash });
      break;
    case "expired":
      safeLedger(rt, { event: "expired", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, refs, code: "expired" });
      break;
    case "blocked":
      safeLedger(rt, { event: "blocked", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, refs, code: res.reason });
      break;
    case "error":
      safeLedger(rt, { event: "error", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, refs, code: res.reason });
      break;
  }

  const details = sendDetails({
    status: res.status,
    msgId: "msgId" in res ? res.msgId : undefined,
    to, room, priority, bodyHash,
    reason: "reason" in res ? res.reason : undefined,
  });
  if (guard.warnings.includes(LOOP_GUARD_WARNING)) details.loopGuard = "matched";
  return textResult(resultText(res), details);
}

// ---------------------------------------------------------------- mesh_reply

const MESH_REPLY_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    msgId: { type: "string", description: "Exact msgId of an inbound message (I5 strict correlation)." },
    message: { type: "string", description: "Reply body (1..32 KiB)." },
    refs: { type: "array", items: { type: "string" }, maxItems: MAX_REFS },
  },
  required: ["msgId", "message"],
};

async function execMeshReply(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const msgId = str(params.msgId);
  const message = str(params.message);
  if (msgId === undefined || message === undefined) {
    return textResult("error: invalid_frame (msgId and message are required)", sendDetails({ status: "error", reason: "invalid_frame" }));
  }
  const refs = Array.isArray(params.refs)
    ? params.refs.filter((r): r is string => typeof r === "string")
    : undefined;
  const bodyHash = sha256(message);

  if (!rt.client.isOnline()) {
    try {
      await rt.client.connect();
    } catch {
      return textResult("blocked: broker_unavailable", sendDetails({ status: "blocked", reason: "broker_unavailable", msgId, bodyHash }));
    }
  }

  // Peek the original BEFORE reply() — read-only, and safe against any
  // future inbox eviction during the round-trip.
  const orig = rt.client.peekInbox(msgId);
  if (orig === undefined || orig.from === undefined) {
    // E9: msgId unknown to the local inbox (or no usable sender) → explicit
    // refusal BEFORE the network call (mirrors client.reply's guard), so no
    // 'sent' record is ever ledgered for a blocked reply.
    safeLedger(rt, { event: "blocked", id: msgId, from: rt.client.alias, bodyHash, refs, code: "reply_without_target" });
    return textResult("blocked: reply_without_target", sendDetails({ status: "blocked", reason: "reply_without_target", msgId, bodyHash }));
  }
  // B13 causal anchoring: 'sent' is ledgered BEFORE the network call,
  // mirroring execMeshSend ordering, enriched with to/room/priority from the
  // peeked original (undefined keys omitted by the ledger, as below).
  safeLedger(rt, { event: "sent", from: rt.client.alias, to: orig.from, room: orig.room, priority: orig.priority, bodyHash, refs });
  const res = await rt.client.reply(msgId, message, refs);
  if (res.status === "error" && res.reason === "reply_without_target") {
    // E9 defense in depth: inbox eviction between peek and reply.
    safeLedger(rt, { event: "blocked", id: msgId, from: rt.client.alias, bodyHash, refs, code: "reply_without_target" });
    return textResult("blocked: reply_without_target", sendDetails({ status: "blocked", reason: "reply_without_target", msgId, bodyHash }));
  }
  if (rt.transcript.isEnabled()) {
    rt.transcript.record("out", buildFrame({ type: "reply", from: rt.client.alias, replyTo: msgId, body: message, refs }));
  }
  safeLedger(rt, {
    event: res.status === "delivered" ? "delivered" : "error",
    id: "msgId" in res ? res.msgId : msgId,
    from: rt.client.alias,
    to: orig?.from,
    room: orig?.room,
    priority: orig?.priority,
    bodyHash, refs,
    code: res.status === "delivered" ? undefined : ("reason" in res ? res.reason : "error"),
  });
  return textResult(
    resultText(res),
    sendDetails({
      status: res.status,
      msgId: "msgId" in res ? res.msgId : msgId,
      replyTo: msgId,
      to: orig?.from,
      room: orig?.room,
      priority: orig?.priority,
      bodyHash,
      reason: "reason" in res ? res.reason : undefined,
    }),
  );
}

// ---------------------------------------------------------------- mesh_status

const MESH_STATUS_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    room: { type: "string", description: "Restrict the snapshot to one room." },
  },
};

async function execMeshStatus(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const room = str(params.room);
  if (!rt.client.isOnline()) {
    try {
      await rt.client.connect();
    } catch {
      return textResult("blocked: broker_unavailable", sendDetails({ status: "blocked", reason: "broker_unavailable" }));
    }
  }
  const snap = await rt.client.status(room);
  const lines = [
    `mesh status — alias @${rt.client.alias}${room !== undefined ? ` room=${room}` : ""}`,
    `peers (${snap.peers.length}):`,
    ...snap.peers.map((p) => `  @${p.alias} rooms=${p.rooms.join(",")}${p.since !== undefined ? ` since=${p.since}` : ""}`),
    `rooms: ${snap.rooms.length > 0 ? snap.rooms.join(", ") : "(none)"}`,
  ];
  return textResult(lines.join("\n"), {
    schema: "mesh.status.v1",
    alias: rt.client.alias,
    room,
    peers: snap.peers.map((p) => ({ alias: p.alias, rooms: p.rooms, since: p.since })),
    rooms: snap.rooms,
  });
}

// ---------------------------------------------------------------- mesh_history

const MESH_HISTORY_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    limit: { type: "number", minimum: 1, maximum: TRANSCRIPT_RING_SIZE, description: "Max frames (default 20)." },
    withBodies: { type: "boolean", description: "Include bodies (default true)." },
  },
};

function execMeshHistory(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): ToolResult {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const limitRaw = typeof params.limit === "number" ? Math.floor(params.limit) : 20;
  const limit = Math.min(TRANSCRIPT_RING_SIZE, Math.max(1, limitRaw));
  const withBodies = params.withBodies !== false;
  // mesh_history reads the client MEMORY ring only — never the ledger (§9.2).
  const frames = rt.client.transcript.slice(-limit);
  const lines = frames.map((f) => {
    const head = `${f.ts} ${f.type} ${f.from ?? "?"}→${f.to ?? "*"}`;
    const body = withBodies && f.body !== undefined ? ` ${f.body}` : "";
    return `${head}${body}`;
  });
  return textResult(
    lines.length > 0 ? lines.join("\n") : "(empty history)",
    { schema: "mesh.history.v1", count: frames.length, withBodies },
  );
}

// ---------------------------------------------------------------- registration

export function registerTools(pi: ExtensionAPI, getRuntime: GetRuntime): void {
  pi.registerTool({
    name: "mesh_send",
    label: "Mesh Send",
    description:
      "Send a message to another local agent via the mesh broker. " +
      "Statuses are honest: delivered = written on the recipient socket (or " +
      "queued_offline in its mailbox), never read/answered. awaitReply waits " +
      "for an explicit mesh_reply; otherwise expired after timeoutMs.",
    promptSnippet: "Message another local agent over mesh (delivered ≠ read ≠ answered).",
    promptGuidelines:
      "Use mesh_reply(msgId) to answer an inbound [mesh] message. " +
      "priority=force requires reason and aborts the recipient turn. " +
      "delivered/queued_offline are NOT completions.",
    parameters: MESH_SEND_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execMeshSend(getRuntime, params),
  });

  pi.registerTool({
    name: "mesh_reply",
    label: "Mesh Reply",
    description:
      "Reply to an inbound mesh message by exact msgId (strict correlation). " +
      "This is the way to answer inbound [mesh] messages. " +
      "Refused with reply_without_target when the msgId is not in the local inbox.",
    promptSnippet: "Reply to a mesh message by msgId.",
    promptGuidelines: "Only msgIds seen in inbound [mesh] messages are valid targets.",
    parameters: MESH_REPLY_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execMeshReply(getRuntime, params),
  });

  pi.registerTool({
    name: "mesh_status",
    label: "Mesh Status",
    description:
      "Real-time snapshot from the broker (status_req): online peers, rooms. " +
      "Presence is observed (live sockets), never a file registry.",
    promptSnippet: "Show online mesh peers and rooms.",
    parameters: MESH_STATUS_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execMeshStatus(getRuntime, params),
  });

  pi.registerTool({
    name: "mesh_history",
    label: "Mesh History",
    description:
      "Last frames from the local in-memory ring buffer (debug). " +
      "Memory only — never the ledger.",
    promptSnippet: "Show recent mesh frames (memory ring, debug).",
    parameters: MESH_HISTORY_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) =>
      Promise.resolve(execMeshHistory(getRuntime, params)),
  });
}

export { MAX_BODY_BYTES };
