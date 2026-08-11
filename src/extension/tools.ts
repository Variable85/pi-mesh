// extension/tools.ts — the 4 mesh tools (§9.2): mesh_send, mesh_reply,
// mesh_status, mesh_history. Plain JSON Schema parameters (zero-dependency).
// Honest statuses: delivered ≠ read ≠ answered (I4). Offline → blocked (I10).
import { computePeerStatus, MeshClient, type SendResult } from "../client/client.js";
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
import { LOOP_GUARD_WARNING, REPLY_REPEAT_WARNING } from "./guards.js";
import { identityFromClient, type MeshIdentity } from "./identity.js";
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
  /** Pi session id — stable across /reload (identity key, D23). */
  sessionId: string;
  /** Identity persistence (alias/rooms/reservations survive reloads). */
  identity: MeshIdentity;
  /** D30: transferred history from a /mesh new handoff (injected at ready). */
  pendingHistory?: string[];
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
      if (res.deliveredCount !== undefined && res.totalCount !== undefined) {
        return `delivered ${res.msgId} (${res.deliveredCount}/${res.totalCount} online)`;
      }
      return `delivered ${res.msgId}`;
    case "queued_offline":
      if (res.deliveredCount !== undefined && res.totalCount !== undefined) {
        return `queued_offline ${res.msgId} (${res.totalCount} targets offline)`;
      }
      return `queued_offline ${res.msgId}`;
    case "reply":
      return `reply ${res.msgId}: ${res.response}`;
    case "expired":
      return `expired ${res.msgId ?? ""} (late replies are still delivered and injected)`;
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
    to: { type: "string", description: "Target alias ('@' tolerated, case-insensitive). OMIT when broadcast: true." },
    message: { type: "string", description: "Message body (1..32 KiB)." },
    room: { type: "string", description: "Room id (default: 'default'). Required for broadcast." },
    broadcast: {
      type: "boolean",
      description: "Fan out to EVERY member of room (to must be omitted). Returns deliveredCount/totalCount.",
    },
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
  const broadcast = params.broadcast === true;
  const toRaw = str(params.to);
  const message = str(params.message);
  if (message === undefined) {
    return textResult("error: invalid_frame (message is required)", sendDetails({ status: "error", reason: "invalid_frame" }));
  }
  if (!broadcast && toRaw === undefined) {
    return textResult("error: invalid_frame (to is required unless broadcast: true)", sendDetails({ status: "error", reason: "invalid_frame" }));
  }
  if (broadcast && toRaw !== undefined) {
    return textResult("error: broadcast_with_to (omit 'to' when broadcasting)", sendDetails({ status: "error", reason: "broadcast_with_to" }));
  }
  // A8: ledger records + tool details store the CANONICAL alias ('@Bob' → 'bob')
  // so ledger predicates are insensitive to how the model typed the alias.
  // Guards (checkSend) and client.send normalize idempotently; result text unchanged.
  const to = toRaw !== undefined ? normalizeAlias(toRaw) : "*"; // '*' = broadcast target
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
    rt.transcript.record("out", buildFrame({ type: "msg", from: rt.client.alias, to, room, priority, body: message, refs, broadcast: broadcast ? true : undefined }));
  }
  safeLedger(rt, {
    event: "sent", from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs,
    code: broadcast ? "broadcast" : undefined,
  });

  const res = await rt.client.send({
    to: broadcast ? undefined : to,
    message, room, priority, reason, awaitReply, timeoutMs, refs, broadcast,
  });

  // C5: `delivered` is ledgered ONLY here — after the broker ack (client.send
  // resolves delivered exclusively post-ack).
  switch (res.status) {
    case "delivered":
      safeLedger(rt, {
        event: "delivered", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs,
        code: broadcast ? `broadcast:${res.deliveredCount ?? 0}/${res.totalCount ?? 0}` : undefined,
      });
      break;
    case "queued_offline":
      safeLedger(rt, {
        event: "queued_offline", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs,
        code: broadcast ? `broadcast:${res.deliveredCount ?? 0}/${res.totalCount ?? 0}` : undefined,
      });
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
    broadcast: broadcast || undefined,
    deliveredCount: "deliveredCount" in res ? res.deliveredCount : undefined,
    totalCount: "totalCount" in res ? res.totalCount : undefined,
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
  const replyAll = params.replyAll === true;
  const toRaw = str(params.to);
  if (replyAll && toRaw !== undefined) {
    return textResult("error: reply_all_with_to (replyAll and to are mutually exclusive)", sendDetails({ status: "error", reason: "reply_all_with_to", msgId }));
  }
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
  safeLedger(rt, {
    event: "sent", from: rt.client.alias, to: toRaw ?? orig.from, room: orig.room, priority: orig.priority, bodyHash, refs,
    code: replyAll ? "reply_all" : toRaw !== undefined ? "reply_to" : undefined,
  });
  // D25: flag re-replies to the same msgId (warning only — never blocks)
  const replyGuard = rt.guards.checkReply(msgId);
  const res = await rt.client.reply(msgId, message, { refs, to: toRaw, replyAll });
  if (res.status === "error" && res.reason === "reply_without_target") {
    // E9 defense in depth: inbox eviction between peek and reply.
    safeLedger(rt, { event: "blocked", id: msgId, from: rt.client.alias, bodyHash, refs, code: "reply_without_target" });
    return textResult("blocked: reply_without_target", sendDetails({ status: "blocked", reason: "reply_without_target", msgId, bodyHash }));
  }
  if (rt.transcript.isEnabled()) {
    rt.transcript.record("out", buildFrame({
      type: "reply", from: rt.client.alias, to: toRaw, room: orig.room, replyTo: msgId,
      body: message, refs, replyAll: replyAll ? true : undefined,
    }));
  }
  safeLedger(rt, {
    event: res.status === "delivered" ? "delivered" : "error",
    id: "msgId" in res ? res.msgId : msgId,
    from: rt.client.alias,
    to: toRaw ?? orig?.from,
    room: orig?.room,
    priority: orig?.priority,
    bodyHash, refs,
    code: res.status === "delivered"
      ? (replyAll ? `reply_all:${res.deliveredCount ?? 0}/${res.totalCount ?? 0}` : toRaw !== undefined ? "reply_to" : undefined)
      : ("reason" in res ? res.reason : "error"),
  });
  const details = sendDetails({
    status: res.status,
    msgId: "msgId" in res ? res.msgId : msgId,
    replyTo: msgId,
    to: toRaw ?? orig?.from,
    room: orig?.room,
    priority: orig?.priority,
    replyAll: replyAll || undefined,
    deliveredCount: "deliveredCount" in res ? res.deliveredCount : undefined,
    totalCount: "totalCount" in res ? res.totalCount : undefined,
    bodyHash,
    reason: "reason" in res ? res.reason : undefined,
  });
  if (replyGuard.warnings.includes(REPLY_REPEAT_WARNING)) details.alreadyReplied = "matched";
  const text = replyGuard.warnings.includes(REPLY_REPEAT_WARNING)
    ? `${resultText(res)} — ⚠️ déjà répondu à ce msgId récemment (vérifie avant de re-répondre)`
    : resultText(res);
  return textResult(text, details);
}

// ---------------------------------------------------------------- mesh_status

const MESH_STATUS_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    room: { type: "string", description: "Restrict the snapshot to one room." },
    all: {
      type: "boolean",
      description: "D29: show EVERY peer of the mesh (all rooms). Default: only peers " +
        "sharing a room with this session (the room visibility rule).",
    },
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
  // D29: by default, only peers VISIBLE from this session (sharing at least
  // one room) are listed — an agent alone in "voice" must not see the
  // cs-room agents. all:true (or an explicit room filter) lifts that.
  const mine = new Set(room !== undefined ? [room] : rt.client.rooms);
  const visible = snap.peers.filter(
    (p) => p.alias === rt.client.alias || mine.size === 0 || p.rooms.some((r) => mine.has(r)),
  );
  const peers = params.all === true ? snap.peers : visible;
  const lines = [
    `mesh status — alias @${rt.client.alias}${room !== undefined ? ` room=${room}` : ""} (my rooms: ${rt.client.rooms.join(",") || "none"})`,
    `peers (${peers.length}):`,
    ...peers.map((p) => {
      const act = computePeerStatus(p.lastSeenAt, (p.reservations?.length ?? 0) > 0, rt.client.activityIdleMs, rt.client.activityStuckMs);
      const actTag = act.status === "active" ? "" : act.status === "stuck" ? ` ✕stuck ${act.idleFor}` : ` ○idle ${act.idleFor}`;
      return `  @${p.alias} rooms=${p.rooms.join(",")}${p.since !== undefined ? ` since=${p.since}` : ""}${actTag}`;
    }),
    `mesh rooms: ${snap.rooms.length > 0 ? snap.rooms.join(", ") : "(none)"}`,
  ];
  const receipts = rt.client.readReceipts(3);
  if (receipts.length > 0) {
    lines.push(
      "",
      "reads:",
      ...receipts.map((r) => `  ${r.msgId.slice(0, 18)} → @${r.alias} at ${r.at.slice(11, 19)}`),
    );
  }
  return textResult(lines.join("\n"), {
    schema: "mesh.status.v1",
    alias: rt.client.alias,
    room,
    peers: peers.map((p) => ({ alias: p.alias, rooms: p.rooms, since: p.since })),
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

// ---------------------------------------------------------------- mesh_ledger

const MESH_LEDGER_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    limit: { type: "number", minimum: 1, maximum: 200, description: "Max records (default 20)." },
    from: { type: "string", description: "Filter: sender alias." },
    to: { type: "string", description: "Filter: recipient alias." },
    room: { type: "string", description: "Filter: room." },
    event: {
      type: "string",
      description: "Filter: sent | delivered | queued_offline | reply | expired | blocked | error | inbound | reserved | released",
    },
  },
};

function execMeshLedger(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): ToolResult {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const limitRaw = typeof params.limit === "number" ? Math.floor(params.limit) : 20;
  const limit = Math.min(200, Math.max(1, limitRaw));
  const records = rt.ledger.read(limit, {
    from: str(params.from),
    to: str(params.to),
    room: str(params.room),
    event: str(params.event),
  });
  if (records.length === 0) {
    return textResult("(no ledger records matching)", { schema: "mesh.ledger.v1", count: 0 });
  }
  const lines = records.map((r) => {
    const id = r.id !== undefined ? ` ${r.id.slice(0, 18)}` : "";
    return `${r.ts.slice(11, 19)} ${r.event}${id} ${r.from ?? "?"}→${r.to ?? "*"}${r.room !== undefined ? ` @${r.room}` : ""}${r.code !== undefined ? ` [${r.code}]` : ""}`;
  });
  return textResult(lines.join("\n"), {
    schema: "mesh.ledger.v1",
    count: records.length,
    filter: { from: str(params.from), to: str(params.to), room: str(params.room), event: str(params.event) },
  });
}

// ---------------------------------------------------------------- mesh_reserve

const MESH_RESERVE_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description:
        "Paths to reserve. Use a trailing '/' for a directory subtree " +
        "(e.g. 'web/tools/'). Relative paths are compared against edit/write " +
        "paths as-is (backslashes tolerated).",
    },
    reason: { type: "string", description: "Why you're reserving these paths (visible to peers)." },
  },
  required: ["paths"],
};

async function execMeshReserve(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const rawPaths = Array.isArray(params.paths)
    ? params.paths.filter((p): p is string => typeof p === "string")
    : [];
  if (rawPaths.length === 0) {
    return textResult("error: invalid_pattern (paths required)", sendDetails({ status: "error", reason: "invalid_pattern" }));
  }
  const reason = str(params.reason);
  const res = await rt.client.reserve(rawPaths, reason);
  if (res.status === "delivered") {
    safeLedger(rt, { event: "reserved", id: res.msgId, from: rt.client.alias, refs: rawPaths, code: reason });
    // D23: reservations must survive /reload → persist identity now.
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
    return textResult(`reserved ${rawPaths.length} path(s) — peers notified`, sendDetails({ status: "delivered", paths: rawPaths, reason }));
  }
  const resReason = "reason" in res ? res.reason : "error";
  safeLedger(rt, { event: "blocked", from: rt.client.alias, refs: rawPaths, code: resReason });
  return textResult(`blocked: ${resReason}`, sendDetails({ status: "blocked", reason: resReason }));
}

// ---------------------------------------------------------------- mesh_release

const MESH_RELEASE_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description: "Specific patterns to release. Omit to release ALL reservations.",
    },
  },
};

async function execMeshRelease(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const rawPaths = Array.isArray(params.paths)
    ? params.paths.filter((p): p is string => typeof p === "string")
    : undefined;
  const res = await rt.client.release(rawPaths);
  if (res.status === "delivered") {
    safeLedger(rt, { event: "released", from: rt.client.alias, refs: res.released.length > 0 ? res.released : undefined });
    // D23: persist the reduced reservation set before returning.
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
    return textResult(
      res.released.length > 0
        ? `released: ${res.released.join(", ")}`
        : "no reservations to release",
      sendDetails({ status: "delivered", released: res.released }),
    );
  }
  const resReason = "reason" in res ? res.reason : "error";
  return textResult(`blocked: ${resReason}`, sendDetails({ status: "blocked", reason: resReason }));
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
      "delivered/queued_offline are NOT completions. " +
      "An 'expired' awaitReply is NOT a lost message: late replies are " +
      "delivered and injected automatically — do not re-send the request, " +
      "check mesh_history first.",
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
    promptGuidelines:
      "Only msgIds seen in inbound [mesh] messages are valid targets. " +
      "Replies interrupt the recipient (steer). If the result warns " +
      "'déjà répondu', you already answered this msgId — do not re-answer.",
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

  pi.registerTool({
    name: "mesh_ledger",
    label: "Mesh Ledger",
    description:
      "Durable mesh history from the hash-only ledger (bodies never stored, I1). " +
      "Filter by sender/recipient/room/event. Use this instead of mesh_history " +
      "for anything older than the in-memory ring.",
    promptSnippet: "Query the durable mesh ledger.",
    parameters: MESH_LEDGER_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) =>
      Promise.resolve(execMeshLedger(getRuntime, params)),
  });

  pi.registerTool({
    name: "mesh_reserve",
    label: "Mesh Reserve",
    description:
      "Reserve files/directories so other agents' edit/write tools get blocked " +
      "on them. Trailing '/' reserves a subtree. Reservations live with the " +
      "connection: they vanish when this session disconnects. Peers are " +
      "notified immediately; use mesh_release when done.",
    promptSnippet: "Claim files before editing to avoid concurrent edits.",
    promptGuidelines:
      "Reserve before editing a shared file, release when done. " +
      "mesh_release({}) releases everything.",
    parameters: MESH_RESERVE_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execMeshReserve(getRuntime, params),
  });

  pi.registerTool({
    name: "mesh_release",
    label: "Mesh Release",
    description:
      "Release reservations. Omit paths to release all. " +
      "Peers are notified immediately.",
    promptSnippet: "Release claimed files.",
    parameters: MESH_RELEASE_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execMeshRelease(getRuntime, params),
  });
}

export { MAX_BODY_BYTES };
