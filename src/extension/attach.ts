// extension/attach.ts — client→session wiring, shared by session_start and
// /mesh reset (D28): both need a fully-wired MeshClient, and reset must be
// able to REPLACE the client in-place without a pi reload.
import { readFileSync } from "node:fs";
import type { WelcomeInfo } from "../client/client.js";
import type { MeshFrame } from "../protocol/envelope.js";
import { InboundBatcher, batchDetails, buildBatchMessage, buildSingleMessage, bypassesBatch } from "./batcher.js";
import type { MeshHud } from "./hud.js";
import { handleInboundSideEffects, injectInbound } from "./inbound.js";
import type { ExtensionAPI, InboundMessage, SessionContext } from "./pi-types.js";
import type { MeshRuntime } from "./tools.js";

/** D43: live-entry previews shown while the agent is busy (B9 cooldown). */
const LIVE_COOLDOWN_MS = 1_500;
const liveCooldowns = new Map<string, number>();

/** D31: session name keeps the first user message after the mesh identity. */
const SESSION_NAME_MSG_MAX = 80;

const SESSION_NAME_SCAN_BYTES = 256 * 1024; // first 256 KiB of the session file

/**
 * Read the FIRST user message of the session file (what pi's /resume shows
 * when no name is set). Best effort; the scan stops at the first user text.
 */
function firstUserMessage(sessionFile: string | undefined): string | undefined {
  if (sessionFile === undefined || sessionFile === "") return undefined;
  let head: string;
  try {
    head = readFileSync(sessionFile, "utf8").slice(0, SESSION_NAME_SCAN_BYTES);
  } catch {
    return undefined;
  }
  for (const line of head.split("\n")) {
    if (line.trim() === "") continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
    } catch {
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = Array.isArray(content)
      ? content
          .map((c) => (typeof c === "object" && c !== null && (c as { type?: string; text?: string }).type === "text" ? (c as { text?: string }).text ?? "" : ""))
          .join(" ")
          .trim()
      : typeof content === "string"
        ? content.trim()
        : "";
    if (text.length > 0) return text.length > SESSION_NAME_MSG_MAX ? `${text.slice(0, SESSION_NAME_MSG_MAX - 1)}…` : text;
  }
  return undefined;
}

/**
 * D31: name the pi session so /resume and the session selector show the mesh
 * identity AND the conversation: `mesh @agent-1 · cs-room — <first message>`.
 * A user-defined name is NEVER overwritten; the mesh name is refreshed on
 * ready/rename/join/leave. The first message is kept exactly like pi's
 * default display (session.name ?? session.firstMessage) so nothing is lost.
 */
export function updateSessionName(pi: ExtensionAPI, rt: MeshRuntime): void {
  try {
    if (typeof pi.getSessionName !== "function" || typeof pi.setSessionName !== "function") return;
    const current = pi.getSessionName();
    if (current !== undefined && current !== "" && !current.startsWith("mesh ")) return;
    const rooms = rt.client.rooms.length > 0 ? ` · ${rt.client.rooms.join(",")}` : "";
    const first = firstUserMessage(rt.ctx?.sessionManager?.getSessionFile?.());
    pi.setSessionName(`mesh @${rt.client.alias}${rooms}${first !== undefined ? ` — ${first}` : ""}`);
  } catch {
    // best effort
  }
}

/**
 * Attach every client event handler to `client`. `rt` is the CURRENT runtime
 * object (its `.client` field may be replaced later by /mesh reset — the
 * handlers always read the runtime they were attached with, so the reset path
 * re-attaches on the new client).
 */
export function attachClientListeners(
  pi: ExtensionAPI,
  rt: MeshRuntime,
  getHud: () => MeshHud | null,
  ctx: SessionContext,
  client: import("../client/client.js").MeshClient,
  saveIdentity: (rt: MeshRuntime) => void,
  /** B9: min gap between two live entries of the SAME agent (anti-flood). */
  liveCooldownMs: number = LIVE_COOLDOWN_MS,
): void {
  const deps = {
    ledger: rt.ledger,
    transcript: rt.transcript,
    selfAlias: client.alias,
    counters: rt,
    read: (msgId: string, from: string) => client.sendRead(msgId, from),
    isReplyToReply: (replyTo: string) => client.isReplyToReply(replyTo),
  };
  // D40: batch inbound messages over a short window → ONE injection (one
  // turn) for a burst; force/remind bypass the batcher (immediate delivery).
  const batcher = new InboundBatcher(
    client.inboundBatchMs,
    client.inboundBatchMaxHoldMs,
    () => rt.ctx?.isIdle?.() === false, // busy = a turn is running (e.g. sleep)
    (frames: MeshFrame[]) => {
    const batch = buildBatchMessage(frames);
    pi.sendMessage(
      {
        customType: "mesh-inbound",
        content: batch.content,
        display: true,
        details: batchDetails(frames),
      },
      { triggerTurn: true, deliverAs: batch.deliverAs },
    );
  },
  );
  client.on("inbound", (frame: MeshFrame) => {
    if (rt === null) return; // session shutting down
    handleInboundSideEffects(frame, deps);
    getHud()?.noteInbound(frame); // L2 preview: transient memory only, never persisted
    if (bypassesBatch(frame) || client.inboundBatchMs <= 0) {
      batcher.flushNow(); // deliver any pending batch first (ordering)
      injectInbound(pi, rt.ctx, frame, {
        replyChain: (frame as unknown as { __replyChain?: boolean }).__replyChain === true,
      });
      return;
    }
    // D43: while the agent is busy (sleep/long tool), the frame is HELD for
    // the batch — show it LIVE in the conversation right now (entry outside
    // the LLM context) so the burst is visible in real time.
    // B9: at most one live entry per agent per cooldown — a 30-reply burst
    // shows a representative preview instead of flooding the conversation
    // (the batch carries the full set at the end).
    if (rt.ctx?.isIdle?.() === false) {
      const from = frame.from ?? "";
      const last = liveCooldowns.get(from) ?? 0;
      const now = Date.now();
      if (now - last >= liveCooldownMs) {
        liveCooldowns.set(from, now);
        if (liveCooldowns.size > 128) liveCooldowns.clear(); // B9 bound
        pi.appendEntry("mesh-live", {
          from: frame.from,
          room: frame.room,
          priority: frame.priority,
          body: frame.body,
          at: frame.ts,
        });
      }
    }
    batcher.push(frame);
  });
  rt.batcher = batcher;

  // presence → appendEntry ONLY, no turn (§9.1)
  client.on("presence", (frame: MeshFrame) => {
    pi.appendEntry("mesh", {
      kind: "mesh-presence",
      alias: frame.from,
      status: frame.status,
      room: frame.room,
      ts: frame.ts,
    });
    getHud()?.scheduleStatusRefresh(); // debounced ≤1/s trailing (hello floods)
  });

  client.on("ready", (welcome: WelcomeInfo) => {
    getHud()?.setConnecting(false);
    getHud()?.fetchStatus(); // fire-and-forget, never blocks session_start
    // D31: session name for /resume (alias + rooms).
    updateSessionName(pi, rt);
    // D23: persist identity as soon as we are connected (covers the very
    // first connect AND every reconnect/rename/reset).
    saveIdentity(rt);
    // D21 identity: tell the agent who it is, once per connection, so it
    // never has to guess its alias (the old file-based mesh had agents
    // confusing each other's identities). display:false keeps it out of
    // the UI; triggerTurn:false avoids an extra turn. The context keeps the
    // FULL picture: peers sharing a room are listed first, the other
    // sessions (with their rooms) after — the agent must know who is where.
    const roomList = (welcome.rooms.length > 0 ? welcome.rooms.join(",") : "default");
    const myRooms = new Set(roomList.split(","));
    const others = welcome.peers.filter((p) => p.alias !== client.alias);
    const online = others.filter((p) => p.rooms.some((r) => myRooms.has(r)));
    const far = others.filter((p) => !p.rooms.some((r) => myRooms.has(r)));
    const peerLine =
      online.length > 0
        ? `Online peers: ${online.map((p) => `@${p.alias}`).join(", ")}.`
        : "Online peers: (none).";
    const farLine =
      far.length > 0
        ? ` Other sessions: ${far
            .slice(0, 12)
            .map((p) => `@${p.alias} (${p.rooms.join(",") || "?"})`)
            .join(", ")}${far.length > 12 ? ` (+${far.length - 12} more)` : ""}.`
        : "";
    let context =
      `[mesh] you are @${client.alias} (rooms: ${roomList}). ` +
      `${peerLine}${farLine} ` +
      `mesh_send/mesh_reply to talk, mesh_status for a live snapshot, ` +
      `mesh_reserve to claim files before editing them.`;
    // D30: a /mesh new handoff may carry the previous session's history —
    // inject it as context so the fresh conversation keeps the thread.
    if (rt.pendingHistory !== undefined && rt.pendingHistory.length > 0) {
      context += `\n\n[mesh] transferred history from the previous session:\n${rt.pendingHistory.join("\n")}`;
    }
    pi.sendMessage(
      {
        customType: "mesh-context",
        content: context,
        display: false,
      },
      { triggerTurn: false },
    );
  });
  client.on("renamed", () => {
    updateSessionName(pi, rt);
    saveIdentity(rt);
  });
  client.on("alias_fallback", ({ from, to }: { from: string; to: string }) => {
    // Another live peer holds our persisted alias (e.g. crashed session) —
    // we took a random one; persist it so the next reload does not fight
    // for the same alias again.
    saveIdentity(rt);
    ctx.ui.notify(`mesh: alias @${from} taken — now connected as @${to}`, { level: "warning" });
  });
  client.on("closed", () => getHud()?.onClosed());
  client.on("expired", ({ msgId }: { msgId: string }) => getHud()?.noteExpired(msgId));
}
