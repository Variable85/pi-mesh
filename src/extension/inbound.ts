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
export function formatInboundContent(frame: MeshFrame): string {
  const room = frame.room ?? "default";
  const priority = frame.priority ?? "normal";
  const prefix = `[mesh] @${frame.from ?? "?"} (room ${room}, ${priority})`;
  if (frame.type === "remind") {
    const replyTo = frame.replyTo ?? frame.id;
    return (
      `${prefix} reminder: reply due for ${replyTo}` +
      ` — reply with the mesh_reply tool using msgId "${replyTo}"`
    );
  }
  return (
    `${prefix} ${frame.body ?? ""}` +
    `\n↩ reply with the mesh_reply tool using msgId "${frame.id}"`
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
 * Inject one inbound msg/mailbox/remind frame into the Pi session.
 * force: controlled abort ONLY when the host exposes abort() AND reports busy
 * (ctx.isIdle() === false), then steer. Never throws (I10).
 */
export function injectInbound(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: SessionContext | null,
  frame: MeshFrame,
): InjectedInbound {
  const priority: MeshPriority = frame.priority ?? "normal";
  const deliverAs = frame.type === "remind" ? "followUp" : mapPriority(priority);
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
  }
  const message: InboundMessage = {
    customType: "mesh-inbound",
    content: formatInboundContent(frame),
    display: true,
    details: inboundDetails(frame),
  };
  pi.sendMessage(message, { triggerTurn: true, deliverAs });
  return { message, deliverAs, aborted };
}
