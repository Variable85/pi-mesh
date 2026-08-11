// extension/index.ts — Pi extension entrypoint (§9.1). Thin adapter: all logic
// lives in client/; this file wires lifecycle, events, ledger and transcript.
// I10: connect() is NON-blocking — tools answer `blocked` when the broker is down.
import { MeshClient, type WelcomeInfo } from "../client/client.js";
import { loadConfig } from "../shared/config.js";
import { runtimeDir, stateDir } from "../shared/paths.js";
import { registerCommands } from "./commands.js";
import { MeshGuards } from "./guards.js";
import { MeshHud } from "./hud.js";
import { attachClientListeners } from "./attach.js";
import { injectInbound } from "./inbound.js";
import { identityFromClient, MeshIdentity } from "./identity.js";
import { MeshLedger } from "./ledger.js";
import type { ExtensionAPI } from "./pi-types.js";
import { findConflict } from "./reservations.js";
import { registerTools, type MeshRuntime } from "./tools.js";
import { MeshTranscript } from "./transcript.js";
import type { MeshFrame } from "../protocol/envelope.js";
import type { SessionContext } from "./pi-types.js";

export default function meshExtension(pi: ExtensionAPI): void {
  let runtime: MeshRuntime | null = null;
  let hud: MeshHud | null = null;
  const getRuntime = (): MeshRuntime | null => runtime;

  // Tools + command are registered IMMEDIATELY (they answer `blocked` offline).
  registerTools(pi, getRuntime);
  registerCommands(pi, getRuntime, () => hud?.onLocalChange(), () => hud);

  /** Persist the current client state as this session's identity (D23). */
  const saveIdentity = (rt: MeshRuntime): void => {
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
  };
  /** Live HUD accessor (the module-level `hud` variable is reassigned). */
  const getHudRef = (): MeshHud | null => hud;

  pi.on("session_start", (_event, ctx) => {
    const sDir = stateDir(); // <cwd>/.mesh or $MESH_STATE_DIR (D19)
    const rDir = runtimeDir();
    const config = loadConfig(sDir);
    // D23: the pi sessionId is stable across /reload — reuse the persisted
    // identity (alias, rooms, reservations) so the agent does NOT lose its
    // mesh identity when the extension is reloaded.
    const sessionId = ctx.sessionManager?.getSessionId() ?? "";
    const identity = new MeshIdentity(sDir);
    const persisted = identity.load(sessionId);
    const client = new MeshClient({
      // explicit config.alias always wins; then the persisted alias; else random
      alias: config.alias ?? persisted?.alias,
      rooms: persisted !== null && persisted.rooms.length > 0 ? persisted.rooms : config.rooms,
      initialReservations: persisted?.reservations,
      runtimeDir: rDir,
      config,
    });
    const ledger = new MeshLedger(sDir, config.ledgerMaxBytes);
    const transcript = new MeshTranscript(sDir, config.transcript, config.transcriptRetentionDays);
    const guards = new MeshGuards();
    runtime = {
      client,
      ledger,
      transcript,
      guards,
      ctx,
      stateDir: sDir,
      runtimeDir: rDir,
      sessionId,
      identity,
      startedAt: Date.now(),
      ledgerFailures: 0,
      transcriptFailures: 0,
      injectionFailures: 0,
    };
    const rt = runtime;

    attachClientListeners(pi, rt, getHudRef, ctx, client, saveIdentity);

    // D21 reservation enforcement: block edit/write on paths another agent
    // has reserved. Runs FIRST (before any other tool handling); the block
    // message tells the agent who holds the reservation and why.
    pi.on("tool_call", (event, _ctx) => {
      const rt = runtime;
      if (rt === null) return;
      if (!rt.client.isOnline()) return;
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const path = typeof event.input?.path === "string" ? event.input.path : undefined;
      if (path === undefined || path === "") return;
      const conflict = findConflict(path, rt.client.peerReservationMap, rt.client.alias);
      if (conflict === undefined) return;
      const holder = conflict.alias;
      const res = conflict.reservation;
      const lines = [
        `${path}`,
        `Reserved by: @${holder}`,
      ];
      if (res.reason !== undefined && res.reason !== "") lines.push(`Reason: "${res.reason}"`);
      if (res.since !== undefined) lines.push(`Since: ${res.since}`);
      lines.push("");
      lines.push(
        `Coordinate via mesh_send({ to: "${holder}", message: "..." }) — ` +
          `or wait for mesh_release.`,
      );
      return { block: true, reason: lines.join("\n") };
    });

    // HUD above the editor: attach after runtime creation, non-blocking.
    hud = new MeshHud({ getRuntime });
    hud.setConnecting(true);
    hud.attach(ctx);

    // NON-blocking connect (I10): failures leave tools answering `blocked`.
    client.connect().catch(() => {});
  });

  pi.on("session_shutdown", async () => {
    const rt = runtime;
    runtime = null;
    const h = hud;
    hud = null;
    h?.detach(); // clears BOTH widget and status
    if (rt !== null) {
      // D23: persist the identity BEFORE closing — the broker purges
      // alias/rooms/reservations with the connection, and the next
      // session_start (e.g. /reload) re-loads them from disk.
      try {
        saveIdentity(rt);
      } catch {
        // best effort (I10)
      }
      // AWAIT the close: /reload fires session_start right after this
      // handler, and the new client re-hellos under the same alias. If the
      // old socket is still alive at the broker, the hello is refused with
      // alias_taken and the session falls back to a random alias. Waiting
      // for the socket to actually close (bounded, ≤ ACK_TIMEOUT_MS) makes
      // the alias handover clean.
      try {
        await rt.client.close();
      } catch {
        // best effort
      }
    }
  });
}
