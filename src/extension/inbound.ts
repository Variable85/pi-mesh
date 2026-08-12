// extension/inbound.ts — session injection of inbound frames (§9.1).
// normal → deliverAs followUp ; urgent → steer ; force → abort (when busy) + steer.
// remind frames re-inject as reminder text. presence frames NEVER inject a turn
// (they are handled via pi.appendEntry in index.ts).
import type { MeshFrame, MeshPriority } from "../protocol/envelope.js";
import type {
  DeliverAs,
  ExtensionAPI,
  InboundMessage,
  SessionContext,
} from "./pi-types.js";

export interface InjectedInbound {
  message: InboundMessage;
  deliverAs: DeliverAs;
  aborted: boolean;
}

/** §9.1 content format: `[mesh] @from (room X, priority) body`. */
export function formatInboundContent(frame: MeshFrame, opts: { replyChain?: boolean } = {}): string {
  const room = frame.room ?? "default";
  const priority = frame.priority ?? "normal";
  const fan = frame.broadcast === true ? ", broadcast" : frame.replyAll === true ? ", reply-all" : "";
  const prefix = `[mesh] @${frame.from ?? "?"} (room ${room}, ${priority}${fan})`;
  if (frame.type === "remind") {
    const replyTo = frame.replyTo ?? frame.id;
    return (
      `${prefix} reminder: reply due for ${replyTo}` +
      ` — reply with the mesh_reply tool using msgId "${replyTo}" ` +
      `(IGNORE this reminder if you ALREADY replied to this msgId)`
    );
  }
  if (frame.type === "reply") {
    // Orphan/answered reply (the original send did not awaitReply): make
    // clear this is an ANSWER to an earlier message, not a new message.
    // D39: a reply-à-reply (target is itself a reply) is INFO ONLY — the
    // LLM decides whether the content is worth reacting to.
    const chain = opts.replyChain === true;
    return (
      `${prefix} reply to ${frame.replyTo ?? "?"}: ${frame.body ?? ""}` +
      (chain
        ? `\n↩ INFO ONLY (reply to a reply): reply ONLY if this is a question or ` +
          `new information — NEVER an acknowledgment; to react, use mesh_send ` +
          `(not mesh_reply)`
        : `\n↩ answer back with the mesh_reply tool using msgId "${frame.id}"`) +
      (frame.replyAll === true
        ? " (this reply went to the whole room)"
        : "")
    );
  }
  return (
    `${prefix} ${frame.body ?? ""}` +
    `\n↩ reply with the mesh_reply tool using msgId "${frame.id}"` +
    (frame.broadcast === true
      ? ` (broadcast to ${frame.totalCount ?? "?"} members — use replyAll to answer the room, or reply to just @${frame.from ?? "?"})`
      : "")
  );
}

export function inboundDetails(frame: MeshFrame): Record<string, unknown> {
  const details: Record<string, unknown> = {
    kind: "mesh-inbound",
    msgId: frame.id,
    from: frame.from,
    room: frame.room ?? "default",
    priority: frame.priority ?? "normal",
  };
  if (frame.bodyHash !== undefined) details.bodyHash = frame.bodyHash;
  if (frame.replyTo !== undefined) details.replyTo = frame.replyTo;
  return details;
}

/** Map priority → delivery mode (§6.6/§9.1). */
export function mapPriority(priority: MeshPriority): DeliverAs {
  return priority === "normal" ? "followUp" : "steer";
}

/**
 * D25: a reply is an ANSWER to something the session is waiting for — it
 * must interrupt the current reflection (steer) instead of queuing until the
 * turn ends (followUp), otherwise the agent keeps working on stale context
 * and re-processes the answer later.
 */
export function mapReplyDelivery(frame: MeshFrame): DeliverAs {
  return frame.type === "reply" ? "steer" : mapPriority(frame.priority ?? "normal");
}

/** Bound for the post-abort idle wait (force priority). */
export const FORCE_IDLE_POLL_MS = 50;
export const FORCE_IDLE_MAX_MS = 3_000;

function buildInboundMessage(frame: MeshFrame, replyChain = false): InboundMessage {
  return {
    customType: "mesh-inbound",
    content: formatInboundContent(frame, { replyChain }),
    display: true,
    details: inboundDetails(frame),
  };
}

/**
 * Deliver a message once the host reports idle, polling every `pollMs` up to
 * `maxMs`. Used for force: after ctx.abort() the steer queue may be purged by
 * the host (abort is not guaranteed to preserve queued messages), so we wait
 * for the run to settle and then start a fresh turn with triggerTurn.
 * Falls back to a plain steer send when the deadline passes.
 */
export function deliverWhenIdle(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: SessionContext,
  frame: MeshFrame,
  replyChain = false,
  pollMs: number = FORCE_IDLE_POLL_MS,
  maxMs: number = FORCE_IDLE_MAX_MS,
): void {
  const message = buildInboundMessage(frame, replyChain);
  const deadline = Date.now() + maxMs;
  let sent = false;
  const trySend = (): void => {
    if (sent) return;
    if ((typeof ctx.isIdle === "function" && ctx.isIdle()) || Date.now() >= deadline) {
      sent = true;
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
      return;
    }
    const t = setTimeout(trySend, pollMs);
    t.unref();
  };
  trySend();
}

/**
 * Inject one inbound msg/mailbox/remind frame into the Pi session.
 * force: controlled abort ONLY when the host exposes abort() AND reports busy
 * (ctx.isIdle() === false), then deliver once idle. Never throws (I10).
 */
export function injectInbound(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: SessionContext | null,
  frame: MeshFrame,
  opts: { replyChain?: boolean } = {},
): InjectedInbound {
  const priority: MeshPriority = frame.priority ?? "normal";
  const replyChain = opts.replyChain === true;
  // D39: a reply-à-reply is INFO ONLY — followUp (no interruption) and the
  // labelled content lets the LLM decide whether to react.
  const deliverAs = frame.type === "reply" && replyChain
    ? "followUp"
    : frame.type === "remind"
      ? "followUp"
      : mapReplyDelivery(frame);
  let aborted = false;
  if (
    priority === "force" &&
    frame.type !== "remind" &&
    ctx !== null &&
    typeof ctx.abort === "function" &&
    typeof ctx.isIdle === "function" &&
    !ctx.isIdle()
  ) {
    ctx.abort();
    aborted = true;
    // Defer the send until the aborted run settles: the host may purge its
    // steer queue on abort, so queueing now risks losing the message (the
    // exact bug that made 'force' unreliable during long tool calls).
    deliverWhenIdle(pi, ctx, frame, replyChain);
    return { message: buildInboundMessage(frame, replyChain), deliverAs: "steer", aborted };
  }
  pi.sendMessage(buildInboundMessage(frame, replyChain), { triggerTurn: true, deliverAs });
  return { message: buildInboundMessage(frame, replyChain), deliverAs, aborted };
}

// ---------------------------------------------------------------------------
// Inbound dispatch (B1): session injection is UNCONDITIONAL — it runs FIRST
// and a disk failure (ENOSPC/EACCES/EROFS) in transcript/ledger can never
// suppress it (the broker already acked delivered; I4 honest-status).
// Ledger/transcript writes are isolated in their own try/catch and failures
// are COUNTED. An injection failure itself is also caught + counted so one
// bad frame cannot kill the handler loop.
// ---------------------------------------------------------------------------

/** B1: failure counters for the inbound path, surfaced via /mesh broker. */
export interface InboundFailureCounters {
  ledgerFailures: number;
  transcriptFailures: number;
  injectionFailures: number;
}

export interface InboundDeps {
  ledger: { append(input: unknown): unknown };
  transcript: { record(dir: "in" | "out", frame: MeshFrame): void };
  selfAlias: string;
  counters: InboundFailureCounters;
  /** D34: send a read receipt for an injected message (msg/mailbox only). */
  read?: (msgId: string, from: string) => void;
  /** D39: tag a reply whose target is itself a reply (info-only delivery). */
  isReplyToReply?: (replyTo: string) => boolean;
}

export function handleInboundFrame(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: SessionContext | null,
  frame: MeshFrame,
  deps: InboundDeps,
): void {
  try {
    const replyChain =
      frame.type === "reply" &&
      frame.replyTo !== undefined &&
      deps.isReplyToReply?.(frame.replyTo) === true;
    injectInbound(pi, ctx, frame, { replyChain });
  } catch {
    deps.counters.injectionFailures += 1; // one bad frame must not kill the loop (I10)
  }
  // D34: the message reached the session → honest read receipt back to the
  // sender (msg/mailbox only — replies and reminds are not 'new' messages).
  if (deps.read !== undefined && (frame.type === "msg" || frame.type === "mailbox")) {
    if (frame.id !== undefined && frame.from !== undefined) {
      try {
        deps.read(frame.id, frame.from);
      } catch {
        // best effort — a failed receipt must never break the handler
      }
    }
  }
  try {
    deps.transcript.record("in", frame);
  } catch {
    deps.counters.transcriptFailures += 1;
  }
  if (frame.type === "msg" || frame.type === "mailbox" || frame.type === "remind" || frame.type === "reply") {
    try {
      deps.ledger.append({
        event: "inbound",
        id: frame.id,
        from: frame.from,
        to: deps.selfAlias,
        room: frame.room,
        priority: frame.priority ?? "normal",
        bodyHash: frame.bodyHash,
        refs: frame.refs,
      });
    } catch {
      deps.counters.ledgerFailures += 1;
    }
  }
}
