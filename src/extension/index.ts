// extension/index.ts — Pi extension entrypoint (§9.1). Thin adapter: all logic
// lives in client/; this file wires lifecycle, events, ledger and transcript.
// I10: connect() is NON-blocking — tools answer `blocked` when the broker is down.
import { MeshClient, type WelcomeInfo } from "../client/client.js";
import { loadConfig } from "../shared/config.js";
import { runtimeDir, stateDir } from "../shared/paths.js";
import { registerCommands } from "./commands.js";
import { MeshGuards } from "./guards.js";
import { MeshHud } from "./hud.js";
import { injectInbound } from "./inbound.js";
import { identityFromClient, MeshIdentity } from "./identity.js";
import { MeshLedger } from "./ledger.js";
import type { ExtensionAPI } from "./pi-types.js";
import { findConflict } from "./reservations.js";
import { registerTools, type MeshRuntime } from "./tools.js";
import { MeshTranscript } from "./transcript.js";
import type { MeshFrame } from "../protocol/envelope.js";
import type { SessionContext } from "./pi-types.js";

/** B1: failure counters for the inbound path, surfaced via /mesh broker. */
export interface InboundFailureCounters {
  ledgerFailures: number;
  transcriptFailures: number;
  injectionFailures: number;
}

export interface InboundDeps {
  ledger: Pick<MeshLedger, "append">;
  transcript: Pick<MeshTranscript, "record">;
  selfAlias: string;
  counters: InboundFailureCounters;
}

/**
 * B1 fix: session injection is UNCONDITIONAL — it runs FIRST and a disk
 * failure (ENOSPC/EACCES/EROFS) in transcript/ledger can never suppress it
 * (the broker already acked delivered; I4 honest-status). Ledger/transcript
 * writes are isolated in their own try/catch and failures are COUNTED.
 * An injection failure itself is also caught + counted so one bad frame
 * cannot kill the handler loop.
 */
export function handleInboundFrame(
  pi: Pick<ExtensionAPI, "sendMessage">,
  ctx: SessionContext | null,
  frame: MeshFrame,
  deps: InboundDeps,
): void {
  try {
    injectInbound(pi, ctx, frame);
  } catch {
    deps.counters.injectionFailures += 1; // one bad frame must not kill the loop (I10)
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

export default function meshExtension(pi: ExtensionAPI): void {
  let runtime: MeshRuntime | null = null;
  let hud: MeshHud | null = null;
  const getRuntime = (): MeshRuntime | null => runtime;

  // Tools + command are registered IMMEDIATELY (they answer `blocked` offline).
  registerTools(pi, getRuntime);
  registerCommands(pi, getRuntime, () => hud?.onLocalChange());

  /** Persist the current client state as this session's identity (D23). */
  const saveIdentity = (rt: MeshRuntime): void => {
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
  };

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

    client.on("inbound", (frame) => {
      const rt = runtime;
      if (rt === null) return; // session shutting down
      handleInboundFrame(pi, rt.ctx, frame, {
        ledger,
        transcript,
        selfAlias: client.alias,
        counters: rt,
      });
      hud?.noteInbound(frame); // L2 preview: transient memory only, never persisted
    });

    // presence → appendEntry ONLY, no turn (§9.1)
    client.on("presence", (frame) => {
      pi.appendEntry("mesh", {
        kind: "mesh-presence",
        alias: frame.from,
        status: frame.status,
        room: frame.room,
        ts: frame.ts,
      });
      hud?.scheduleStatusRefresh(); // debounced ≤1/s trailing (hello floods)
    });

    client.on("ready", (welcome: WelcomeInfo) => {
      hud?.setConnecting(false);
      hud?.fetchStatus(); // fire-and-forget, never blocks session_start
      // D23: persist identity as soon as we are connected (covers the very
      // first connect AND every reconnect/rename).
      if (rt !== null) saveIdentity(rt);
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
      if (rt !== null) saveIdentity(rt);
    });
    client.on("alias_fallback", ({ from, to }: { from: string; to: string }) => {
      // Another live peer holds our persisted alias (e.g. crashed session) —
      // we took a random one; persist it so the next reload does not fight
      // for the same alias again.
      if (rt !== null) saveIdentity(rt);
      ctx.ui.notify(`mesh: alias @${from} taken — now connected as @${to}`, { level: "warning" });
    });
    client.on("closed", () => hud?.onClosed());
    client.on("expired", ({ msgId }) => hud?.noteExpired(msgId));

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

  pi.on("session_shutdown", () => {
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
      rt.client.close().catch(() => {});
    }
  });
}
