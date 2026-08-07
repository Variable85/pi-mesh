// extension/index.ts — Pi extension entrypoint (§9.1). Thin adapter: all logic
// lives in client/; this file wires lifecycle, events, ledger and transcript.
// I10: connect() is NON-blocking — tools answer `blocked` when the broker is down.
import { MeshClient } from "../client/client.js";
import { loadConfig } from "../shared/config.js";
import { runtimeDir, stateDir } from "../shared/paths.js";
import { registerCommands } from "./commands.js";
import { MeshGuards } from "./guards.js";
import { MeshHud } from "./hud.js";
import { injectInbound } from "./inbound.js";
import { MeshLedger } from "./ledger.js";
import type { ExtensionAPI } from "./pi-types.js";
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
  if (frame.type === "msg" || frame.type === "mailbox" || frame.type === "remind") {
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

  pi.on("session_start", (_event, ctx) => {
    const sDir = stateDir(); // <cwd>/.mesh or $MESH_STATE_DIR (D19)
    const rDir = runtimeDir();
    const config = loadConfig(sDir);
    const client = new MeshClient({
      alias: config.alias,
      rooms: config.rooms,
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
      startedAt: Date.now(),
      ledgerFailures: 0,
      transcriptFailures: 0,
      injectionFailures: 0,
    };

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

    client.on("ready", () => {
      hud?.setConnecting(false);
      hud?.fetchStatus(); // fire-and-forget, never blocks session_start
    });
    client.on("closed", () => hud?.onClosed());
    client.on("expired", ({ msgId }) => hud?.noteExpired(msgId));

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
      rt.client.close().catch(() => {});
    }
  });
}
