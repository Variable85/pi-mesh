// extension/index.ts — Pi extension entrypoint. Thin adapter: all logic
// lives in client/; this file wires lifecycle, events, ledger and transcript.
// connect is NON-blocking — tools answer `blocked` when the broker is down.
import { MeshClient, type WelcomeInfo } from "../client/client.js";
import { loadConfig } from "../shared/config.js";
import { runtimeDir, stateDir } from "../shared/paths.js";
import { registerCommands } from "./commands.js";
import { MeshGuards } from "./guards.js";
import { MeshHud } from "./hud.js";
import { attachClientListeners } from "./attach.js";
import { injectInbound } from "./inbound.js";
import { renderLiveEntry, renderMeshInbound, renderVerdictEntry } from "./renderer.js";
import type { PersistedIdentity } from "./identity.js";
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
  // live inbound entries rendered while a tool call runs (outside the
  // LLM context — zero tokens), so bursts are visible in real time.
  if (typeof pi.registerEntryRenderer === "function") {
    pi.registerEntryRenderer<{ from?: string; room?: string; body?: string; at?: string }>(
      "mesh-live",
      (entry, _options, theme) => ({
        render: (width: number) =>
          renderLiveEntry(entry.data, width, {
            fg: (color, text) => theme.fg(color, text),
            bg: (color, text) => theme.bg?.(color, text) ?? text,
            bold: (text) => theme.bold?.(text) ?? text,
          }),
        invalidate: () => {},
      }),
    );
  }
  // mesh-verdict: the colored mesh_wait_all result (display only — the
  // entry lives OUTSIDE the LLM context; the tool result carries the text).
  if (typeof pi.registerEntryRenderer === "function") {
    pi.registerEntryRenderer<{ head?: string; answers?: { to: string; response: string }[]; missing?: { to: string; msgId: string }[] }>(
      "mesh-verdict",
      (entry, _options, theme) => ({
        render: (width: number) =>
          renderVerdictEntry(entry.data, width, {
            fg: (color, text) => theme.fg(color, text),
            bg: (color, text) => theme.bg?.(color, text) ?? text,
            bold: (text) => theme.bold?.(text) ?? text,
            fgAnsi: (color) => (theme as unknown as { getFgAnsi(c: string): string }).getFgAnsi(color),
          }),
        invalidate: () => {},
      }),
    );
  }
  // colored rendering of mesh messages (simple + batches).
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer<{ kind?: string; count?: number }>(
      "mesh-inbound",
      (message, _options, theme) => {
        const content = typeof message.content === "string" ? message.content : "";
        const details = message.details;
        return {
          render: (width: number) =>
            renderMeshInbound(content, details, width, {
              fg: (color, text) => theme.fg(color, text),
              bg: (color, text) => theme.bg?.(color, text) ?? text,
              bold: (text) => theme.bold?.(text) ?? text,
            }),
          invalidate: () => {},
        };
      },
    );
  }


  /** Persist the current client state as this session's identity. */
  const saveIdentity = (rt: MeshRuntime): void => {
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
  };
  /** Live HUD accessor (the module-level `hud` variable is reassigned). */
  const getHudRef = (): MeshHud | null => hud;

  pi.on("session_start", (_event, ctx) => {
    const sDir = stateDir(); // <cwd>/.mesh or $MESH_STATE_DIR
    const rDir = runtimeDir();
    const config = loadConfig(sDir);
  // the pi sessionId is stable across /reload — reuse the persisted
  // identity (alias, rooms, reservations) so the agent does NOT lose its
  // mesh identity when the extension is reloaded.
    const sessionId = ctx.sessionManager?.getSessionId() ?? "";
    const identity = new MeshIdentity(sDir);
  // /mesh new handoff — the staged identity (alias/rooms/reservations
  // and optionally the history) is consumed by the next session_start.
    let persisted: PersistedIdentity | null = identity.load(sessionId);
    let pendingHistory: string[] | undefined;
    if (persisted === null) {
      const pending = identity.consumePending();
      if (pending !== null) {
        persisted = pending.identity;
        pendingHistory = pending.history;
      }
    }
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
      pendingHistory,
      startedAt: Date.now(),
      ledgerFailures: 0,
      transcriptFailures: 0,
      injectionFailures: 0,
      appendEntry: (type, data) => pi.appendEntry(type, data),
    };
    const rt = runtime;

    attachClientListeners(pi, rt, getHudRef, ctx, client, saveIdentity);

  // Phase 3: announce turn state to the mesh — busy on the first tool
  // call of a turn, idle when the whole run settles. Only on CHANGE
  // (2 frames per turn, never spams the room).
    let announcedActivity: "busy" | "idle" | null = null;
    const announce = (state: "busy" | "idle"): void => {
      if (announcedActivity === state) return;
      announcedActivity = state;
      client.sendActivity(state);
    };
    announce("idle"); // present and waiting from the start
    pi.on("tool_call", (_event, _ctx) => announce("busy"));
    pi.on("agent_settled", (_event, _ctx) => announce("idle"));

  // reservation enforcement: block edit/write on paths another agent
  // has reserved. Runs FIRST (before any other tool handling); the block
  // message tells the agent who holds the reservation and why.
    pi.on("tool_call", (event, _ctx) => {
      const rt = runtime;
      if (rt === null) return;
      if (!rt.client.isOnline()) return;
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const path = typeof event.input?.path === "string" ? event.input.path : undefined;
      if (path === undefined || path === "") return;
      const conflict = findConflict(path, rt.client.peerReservationMap, rt.client.alias, rt.client.reservationTtlMs);
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

  // NON-blocking connect: failures leave tools answering `blocked`.
    client.connect().catch(() => {});
  });

  // a pi FORK creates a fresh session — hand the mesh identity over
  // (like /mesh new, without history) so the forked session keeps alias,
  // rooms and reservations instead of starting anonymous.
  // when a tool call ends (e.g. the sleep), the busy period is over —
  // deliver every held inbound message as ONE batch, so the next LLM call
  // sees the whole lot in a single turn instead of one message per turn.
  pi.on("tool_result", async (_event, _ctx) => {
    try {
      runtime?.batcher?.flushNow();
    } catch {
  // a send during teardown must never break the handler
    }
  });

  pi.on("session_before_fork", (_event, ctx) => {
    const rt = runtime;
    if (rt === null) return;
    try {
      rt.identity.savePending(identityFromClient(rt.sessionId, rt.client));
    } catch {
  // best effort
    }
  });

  pi.on("session_shutdown", async () => {
    const rt = runtime;
    runtime = null;
    const h = hud;
    hud = null;
    h?.detach(); // clears BOTH widget and status
    if (rt !== null) {
  // deliver anything still buffered —: pi.sendMessage may throw
  // while the runtime is shutting down; never break session_shutdown.
      try {
        rt.batcher?.flushNow();
      } catch {
  // best effort
      }
  // persist the identity BEFORE closing — the broker purges
  // alias/rooms/reservations with the connection, and the next
  // session_start (e.g. /reload) re-loads them from disk.
      try {
        saveIdentity(rt);
      } catch {
  // best effort
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
