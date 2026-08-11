// extension/attach.ts — client→session wiring, shared by session_start and
// /mesh reset (D28): both need a fully-wired MeshClient, and reset must be
// able to REPLACE the client in-place without a pi reload.
import type { WelcomeInfo } from "../client/client.js";
import type { MeshFrame } from "../protocol/envelope.js";
import type { MeshHud } from "./hud.js";
import { handleInboundFrame } from "./inbound.js";
import type { ExtensionAPI, SessionContext } from "./pi-types.js";
import type { MeshRuntime } from "./tools.js";

/**
 * D31: name the pi session so /resume and the session selector show the mesh
 * identity at a glance: `mesh @agent-1 · cs-room`. A user-defined name is
 * NEVER overwritten; the mesh name is refreshed on ready/rename/join/leave.
 */
export function updateSessionName(pi: ExtensionAPI, rt: MeshRuntime): void {
  try {
    if (typeof pi.getSessionName !== "function" || typeof pi.setSessionName !== "function") return;
    const current = pi.getSessionName();
    if (current !== undefined && current !== "" && !current.startsWith("mesh ")) return;
    const rooms = rt.client.rooms.length > 0 ? ` · ${rt.client.rooms.join(",")}` : "";
    pi.setSessionName(`mesh @${rt.client.alias}${rooms}`);
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
): void {
  client.on("inbound", (frame: MeshFrame) => {
    if (rt === null) return; // session shutting down
    handleInboundFrame(pi, rt.ctx, frame, {
      ledger: rt.ledger,
      transcript: rt.transcript,
      selfAlias: client.alias,
      counters: rt,
    });
    getHud()?.noteInbound(frame); // L2 preview: transient memory only, never persisted
  });

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
    // the UI; triggerTurn:false avoids an extra turn. Peers are filtered to
    // those sharing a room (room visibility rule) — the welcome lists all.
    const roomList = (welcome.rooms.length > 0 ? welcome.rooms.join(",") : "default");
    const myRooms = new Set(roomList.split(","));
    const peers = welcome.peers
      .filter((p) => p.alias !== client.alias && p.rooms.some((r) => myRooms.has(r)))
      .map((p) => `@${p.alias}`)
      .join(", ") || "(none)";
    let context =
      `[mesh] you are @${client.alias} (rooms: ${roomList}). ` +
      `Online peers: ${peers}. ` +
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
