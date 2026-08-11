// extension/commands.ts — /mesh command (§9.3). All output via ctx.ui.notify.
import { readFileSync } from "node:fs";
import { MeshClient } from "../client/client.js";
import type { MeshRole } from "../protocol/envelope.js";
import { loadConfig } from "../shared/config.js";
import { brokerLockPath, brokerSocketPath } from "../shared/paths.js";
import { attachClientListeners } from "./attach.js";
import type { MeshHud } from "./hud.js";
import { identityFromClient } from "./identity.js";
import type { ExtensionAPI, SessionContext } from "./pi-types.js";
import type { GetRuntime, MeshRuntime } from "./tools.js";

const HELP_TEXT = [
  "/mesh status [room]   — broker snapshot (online peers, rooms)",
  "/mesh join <room> [as <alias>] [observer]",
  "/mesh leave <room>",
  "/mesh alias [<new-alias>] — show, or change this session's alias live",
  "/mesh new [--history]  — fresh pi session like /new, mesh identity (alias, rooms,",
  "                         reservations) handed over; --history carries the last frames",
  "/mesh reset            — factory-reset the mesh identity (like /new: fresh alias,",
  "                         default rooms, no reservations) WITHOUT leaving this session",
  "/mesh log [on|off]    — opt-in transcript (redacted bodies)",
  "/mesh ping <alias>    — send a one-shot ping message",
  "/mesh broker          — socket path, lock pid, session state",
  "/mesh help",
].join("\n");

function notify(ctx: SessionContext, message: string): void {
  ctx.ui.notify(message, { level: "info" });
}

/** D23: persist alias/rooms after a mutation (join/leave/rename). */
function persistIdentity(rt: MeshRuntime): void {
  try {
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
  } catch {
    // best effort (I10)
  }
}

/**
 * Parse `/mesh join <room> [as <alias>] [observer]` args.
 * Pure, exported for tests.
 */
export function parseJoinArgs(args: string[]): {
  room?: string;
  asAlias?: string;
  observer: boolean;
} {
  const rest = args.filter((a) => a !== "observer");
  const observer = args.includes("observer");
  const asIdx = rest.indexOf("as");
  if (asIdx === -1) return { room: rest[0], observer };
  const asAlias = rest[asIdx + 1];
  if (asIdx === 0) return { asAlias, observer };
  return { room: rest[0], asAlias, observer };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdStatus(rt: MeshRuntime, ctx: SessionContext, room?: string): Promise<void> {
  if (!rt.client.isOnline()) {
    try {
      await rt.client.connect();
    } catch {
      notify(ctx, "mesh: blocked broker_unavailable");
      return;
    }
  }
  const snap = await rt.client.status(room);
  if (snap.peers.length === 0) {
    notify(ctx, `mesh: no online peers${room !== undefined ? ` in room ${room}` : ""}`);
    return;
  }
  const lines = snap.peers.map(
    (p) => `@${p.alias} rooms=${p.rooms.join(",")}${p.since !== undefined ? ` since=${p.since}` : ""}`,
  );
  notify(ctx, `mesh peers (${snap.peers.length}):\n${lines.join("\n")}\nrooms: ${snap.rooms.join(", ") || "(none)"}`);
}

async function cmdJoin(
  rt: MeshRuntime,
  ctx: SessionContext,
  room: string | undefined,
  observer: boolean,
  asAlias?: string,
): Promise<void> {
  // `/mesh join <room> as <alias>`: rename first (re-hello), then join.
  // A rename failure NEVER aborts the join — the session keeps its current
  // alias and still joins the room (same_alias is a no-op success).
  if (asAlias !== undefined) {
    const renamed = await rt.client.rename(asAlias);
    if (renamed.ok) {
      if (renamed.unchanged !== true) {
        notify(ctx, `mesh: alias changed @${renamed.alias}`);
        persistIdentity(rt);
      }
    } else {
      notify(ctx, `mesh: rename to "${asAlias}" failed: ${renamed.reason} — joining as @${rt.client.alias}`);
    }
  }
  if (room === undefined) {
    notify(ctx, "usage: /mesh join <room> [as <alias>] [observer]");
    return;
  }
  const role: MeshRole = observer ? "observer" : "member";
  try {
    await rt.client.join(room, role);
    notify(ctx, `mesh: joined ${room} as ${role}`);
    persistIdentity(rt);
  } catch (err) {
    notify(ctx, `mesh: join failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdLeave(rt: MeshRuntime, ctx: SessionContext, room: string | undefined): Promise<void> {
  if (room === undefined) {
    notify(ctx, "usage: /mesh leave <room>");
    return;
  }
  try {
    await rt.client.leave(room);
    notify(ctx, `mesh: left ${room}`);
    persistIdentity(rt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "not_member") {
      // Honest + friendly: the broker does not know us in this room. The
      // local joinedRooms set is resynced by client.leave() so a later
      // reconnect does not try to rejoin it.
      notify(ctx, `mesh: not in room "${room}" — nothing to leave`);
    } else {
      notify(ctx, `mesh: leave failed: ${msg}`);
    }
  }
}

async function cmdAlias(rt: MeshRuntime, ctx: SessionContext, alias: string | undefined): Promise<void> {
  if (alias === undefined) {
    notify(ctx, `mesh alias: @${rt.client.alias}`);
    return;
  }
  const renamed = await rt.client.rename(alias);
  if (renamed.ok) {
    if (renamed.unchanged !== true) {
      notify(ctx, `mesh: alias changed @${renamed.alias}`);
      persistIdentity(rt);
    } else {
      notify(ctx, `mesh alias: @${rt.client.alias}`);
    }
  } else {
    notify(ctx, `mesh: rename to "${alias}" failed: ${renamed.reason}`);
  }
}

async function cmdNew(
  rt: MeshRuntime,
  ctx: SessionContext,
  withHistory: boolean,
): Promise<void> {
  // D30: /mesh new — like pi's /new (fresh conversation) but the mesh
  // identity (alias, rooms, reservations) is handed to the NEXT session via
  // identity-pending.json; the next session_start consumes it.
  const history = withHistory
    ? rt.client.transcript
        .slice(-30)
        .map(
          (f) =>
            `${f.ts.slice(11, 19)} ${f.type} ${f.from ?? "?"}→${f.to ?? "*"}: ${(f.body ?? "").slice(0, 120)}`,
        )
    : undefined;
  rt.identity.savePending(identityFromClient(rt.sessionId, rt.client), history);
  if (typeof ctx.newSession !== "function") {
    notify(ctx, "mesh: /mesh new requires a TUI session (newSession unavailable)");
    return;
  }
  // The ctx becomes STALE after newSession() resolves — notify BEFORE, and
  // do any post-replacement work inside withSession (fresh ctx).
  notify(ctx, `mesh: opening a new session — @${rt.client.alias} handed off (rooms/reservations kept)`);
  const res = await ctx.newSession({
    withSession: async (newCtx) => {
      // fresh session context: report the handoff there
      try {
        newCtx.ui?.notify("mesh: identity handoff received — same alias/rooms/reservations", {
          level: "info",
        });
      } catch {
        // best effort
      }
    },
  });
  // NOTE: do NOT touch `ctx` here (stale after newSession). If the user
  // cancelled, the staged pending expires by itself (PENDING_TTL_MS).
  void res;

async function cmdReset(
  rt: MeshRuntime,
  ctx: SessionContext,
  pi: ExtensionAPI,
  getHud: () => MeshHud | null,
): Promise<void> {
  // D28: like /new (fresh alias, default rooms, no reservations) but stays in
  // this pi session, like /reload does for identity preservation.
  const oldAlias = rt.client.alias;
  // 1. leave the mesh cleanly (alias/rooms/reservations purged at the broker)
  await rt.client.close().catch(() => {});
  // 2. factory-reset the persisted identity for this session
  rt.identity.reset(rt.sessionId);
  // 3. spawn a fresh client in-place (same runtime object, re-attached)
  const config = loadConfig(rt.stateDir);
  const fresh = new MeshClient({
    alias: config.alias, // explicit config.alias wins; otherwise random
    rooms: config.rooms,
    runtimeDir: rt.runtimeDir,
    config,
  });
  rt.client = fresh;
  attachClientListeners(pi, rt, getHud, ctx, fresh, (r) => {
    try {
      r.identity.save(identityFromClient(r.sessionId, r.client));
    } catch {
      // best effort (I10)
    }
  });
  fresh.connect().catch(() => {
    notify(ctx, "mesh: reset — broker unavailable, tools answer blocked");
  });
  notify(ctx, `mesh: identity reset — was @${oldAlias}, reconnecting with a fresh identity…`);
}

function cmdLog(rt: MeshRuntime, ctx: SessionContext, arg: string | undefined): void {
  if (arg === "on") {
    rt.transcript.setEnabled(true);
    notify(ctx, "mesh: transcript ON (bodies redacted, retention applies)");
  } else if (arg === "off") {
    rt.transcript.setEnabled(false);
    notify(ctx, "mesh: transcript OFF");
  } else {
    notify(ctx, `mesh: transcript is ${rt.transcript.isEnabled() ? "ON" : "OFF"}`);
  }
}

async function cmdPing(rt: MeshRuntime, ctx: SessionContext, alias: string | undefined): Promise<void> {
  if (alias === undefined) {
    notify(ctx, "usage: /mesh ping <alias>");
    return;
  }
  const res = await rt.client.send({ to: alias, message: "ping" });
  switch (res.status) {
    case "delivered":
      notify(ctx, `mesh: pong-path ok — delivered ${res.msgId}`);
      break;
    case "queued_offline":
      notify(ctx, `mesh: @${alias} offline — queued ${res.msgId}`);
      break;
    default:
      notify(ctx, `mesh: ping ${res.status}${"reason" in res ? `: ${res.reason}` : ""}`);
  }
}

function cmdBroker(rt: MeshRuntime, ctx: SessionContext): void {
  const sock = brokerSocketPath(rt.runtimeDir);
  let lockInfo = "absent";
  try {
    const pid = Number(readFileSync(brokerLockPath(rt.runtimeDir), "utf8").trim());
    if (Number.isFinite(pid)) lockInfo = `pid=${pid} alive=${pidAlive(pid)}`;
  } catch {
    // no lock file
  }
  const uptimeS = Math.floor((Date.now() - rt.startedAt) / 1000);
  notify(
    ctx,
    [
      `mesh broker:`,
      `  socket: ${sock}`,
      `  lock: ${lockInfo}`,
      `  online: ${rt.client.isOnline()}`,
      `  session uptime: ${uptimeS}s`,
      `  inbound failures: ledger=${rt.ledgerFailures} transcript=${rt.transcriptFailures} injection=${rt.injectionFailures}`,
    ].join("\n"),
  );
}

export function registerCommands(
  pi: ExtensionAPI,
  getRuntime: GetRuntime,
  onChanged?: () => void, // HUD refresh after join/leave/log toggles
  getHud: () => MeshHud | null = () => null,
): void {
  pi.registerCommand("mesh", {
    description: "mesh inter-agent coms: status, join/leave, alias, log, ping, broker",
    handler: async (args, ctx) => {
      const rt = getRuntime();
      if (rt === null) {
        notify(ctx, "mesh: session not started");
        return;
      }
      const [sub, ...rest] = args.trim().split(/\s+/).filter((s) => s.length > 0);
      switch (sub) {
        case "status":
          await cmdStatus(rt, ctx, rest[0]);
          break;
        case "join": {
          // `/mesh join <room> [as <alias>] [observer]`
          const parsed = parseJoinArgs(rest);
          await cmdJoin(rt, ctx, parsed.room, parsed.observer, parsed.asAlias);
          onChanged?.();
          break;
        }
        case "leave":
          await cmdLeave(rt, ctx, rest[0]);
          onChanged?.();
          break;
        case "alias":
          await cmdAlias(rt, ctx, rest[0]);
          onChanged?.();
          break;
        case "log":
          cmdLog(rt, ctx, rest[0]);
          onChanged?.();
          break;
        case "ping":
          await cmdPing(rt, ctx, rest[0]);
          break;
        case "broker":
          cmdBroker(rt, ctx);
          break;
        case "new":
          await cmdNew(rt, ctx, rest.includes("--history") || rest.includes("history"));
          break;
        case "reset":
          await cmdReset(rt, ctx, pi, getHud);
          onChanged?.();
          break;
        case "help":
        case undefined:
          notify(ctx, HELP_TEXT);
          break;
        default:
          notify(ctx, `mesh: unknown subcommand '${sub}'\n${HELP_TEXT}`);
      }
    },
  });
}
