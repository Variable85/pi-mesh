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
    // D23: persist identity as soon as we are connected (covers the very
    // first connect AND every reconnect/rename/reset).
    saveIdentity(rt);
    // D21 identity: tell the agent who it is, once per connection, so it
    // never has to guess its alias (the old file-based mesh had agents
    // confusing each other's identities). display:false keeps it out of
    // the UI; triggerTurn:false avoids an extra turn.
    const roomList = (welcome.rooms.length > 0 ? welcome.rooms.join(",") : "default");
    const peers = welcome.peers.map((p) => `@${p.alias}`).join(", ") || "(none)";
    pi.sendMessage(
      {
        customType: "mesh-context",
        content:
          `[mesh] you are @${client.alias} (rooms: ${roomList}). ` +
          `Online peers: ${peers}. ` +
          `mesh_send/mesh_reply to talk, mesh_status for a live snapshot, ` +
          `mesh_reserve to claim files before editing them.`,
        display: false,
      },
      { triggerTurn: false },
    );
  });
  client.on("renamed", () => {
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
