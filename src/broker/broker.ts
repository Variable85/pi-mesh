// broker/broker.ts — mesh.v1 broker server (§7). Stateless in-memory (D14).
// Run directly (`node dist/src/broker/broker.js`) or via startBroker({config, policy}) in tests.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net, { type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  buildFrame,
  parseFrameLine,
  type MeshErrorCode,
  type MeshFrame,
} from "../protocol/envelope.js";
import { encodeFrame, FrameDecoder, FrameSizeError } from "../protocol/frames.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_ROOM,
  HELLO_TIMEOUT_MS,
  MAILBOX_PURGE_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
  WRITE_TIMEOUT_MS,
  loadConfig,
  type MeshConfig,
} from "../shared/config.js";
import { brokerLockPath, brokerSocketPath, runtimeDir, stateDir } from "../shared/paths.js";
import { enqueueMailbox, flushMailbox, mailboxSize, purgeAllExpired } from "./mailbox.js";
import { evaluatePolicy, loadPolicy, type MeshPolicy } from "./policy.js";
import { checkRate, type RateKind } from "./ratelimit.js";
import {
  announceOnline,
  broadcastToRoom,
  detachFromRooms,
  joinRoom,
  leaveRoom,
  peersSnapshot,
  presenceFrame,
} from "./rooms.js";
import { BrokerState, type PeerRecord } from "./state.js";

export interface BrokerOptions {
  config: MeshConfig;
  policy: MeshPolicy;
  socketPath?: string;
}

export interface RunningBroker {
  server: Server;
  state: BrokerState;
  socketPath: string;
  close: () => Promise<void>;
}

type WriteCallback = (ok: boolean) => void;

/** Bounded write (5 s, §6.1). cb(false) on timeout/error; socket destroyed. */
function writeFrame(
  socket: Socket,
  frame: MeshFrame,
  maxBytes: number,
  cb: WriteCallback,
): void {
  let settled = false;
  const finish = (ok: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cb(ok);
  };
  const timer = setTimeout(() => {
    socket.destroy();
    finish(false);
  }, WRITE_TIMEOUT_MS);
  timer.unref();
  let buf: Buffer;
  try {
    buf = encodeFrame(frame, maxBytes);
  } catch {
    clearTimeout(timer);
    settled = true;
    cb(false);
    return;
  }
  if (socket.destroyed || !socket.writable) {
    finish(false);
    return;
  }
  socket.write(buf, (err) => finish(!err));
}

export function createBroker(options: BrokerOptions): Promise<RunningBroker> {
  const { config, policy } = options;
  const sockPath = options.socketPath ?? brokerSocketPath();
  const state = new BrokerState();

  const sendTo = (peer: PeerRecord, frame: MeshFrame): void => {
    writeFrame(peer.socket, frame, config.maxFrameBytes, (ok) => {
      // B2: identity guard — only close if this exact record is still current
      // (the alias may have re-hello'd onto a new socket since the write).
      if (!ok && state.peers.get(peer.alias) === peer) {
        closePeer(state, peer.alias, "write_failure");
      }
    });
  };

  const sendError = (socket: Socket, code: MeshErrorCode, id?: string): void => {
    writeFrame(socket, buildFrame({ type: "error", code, id }), config.maxFrameBytes, () => {});
  };

  const sendAck = (
    peer: PeerRecord,
    id: string,
    status: "delivered" | "queued_offline" | "dropped_offline" | "ok",
    interruptStatus?: string,
  ): void => {
    sendTo(peer, buildFrame({ type: "ack", id, status, interruptStatus }));
  };

  // ---- §7.3 handlers ----

  const handleHello = (socket: Socket, frame: MeshFrame): void => {
    const alias = frame.from;
    if (alias === undefined) {
      sendError(socket, "invalid_alias", frame.id);
      socket.destroy();
      return;
    }
    const existing = state.peers.get(alias);
    if (existing && existing.socket !== socket && !existing.socket.destroyed) {
      sendError(socket, "alias_taken", frame.id); // I3: same-tick refusal
      socket.destroy();
      return;
    }
    if (existing) state.peers.delete(alias);

    const peer: PeerRecord = {
      alias,
      socket,
      rooms: new Map(),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      helloDone: true,
    };
    state.peers.set(alias, peer);
    state.knownAliases.add(alias);

    // default room auto-joined (D6), then requested rooms (union, deduped)
    const requested = new Set<string>([DEFAULT_ROOM, ...(frame.rooms ?? [])]);
    for (const roomId of requested) {
      const role = frame.role ?? "member";
      const res = joinRoom(state, config, peer, roomId, role);
      if (!res.ok) {
        sendError(socket, res.code, frame.id);
        detachFromRooms(state, peer);
        state.peers.delete(alias);
        socket.destroy();
        return;
      }
    }

    const mailboxFrames = flushMailbox(state, config, alias);
    sendTo(
      peer,
      buildFrame({
        type: "welcome",
        id: frame.id,
        from: alias,
        rooms: [...peer.rooms.keys()],
        peers: peersSnapshot(state),
        mailboxCount: mailboxFrames.length,
      }),
    );
    for (const mf of mailboxFrames) sendTo(peer, mf); // §7.7: mailbox frames right after welcome
    announceOnline(state, peer, sendTo);
  };

  const routeMsg = (from: PeerRecord, frame: MeshFrame): void => {
    const to = frame.to;
    const room = frame.room ?? DEFAULT_ROOM;
    if (to === undefined) {
      state.stats.refused += 1;
      sendError(from.socket, "invalid_frame", frame.id);
      return;
    }
    // room shared between emitter and recipient (§6.5, E18)
    if (!from.rooms.has(room)) {
      state.stats.refused += 1;
      sendError(from.socket, "not_member", frame.id);
      return;
    }
    if (from.rooms.get(room) === "observer") {
      state.stats.refused += 1;
      sendError(from.socket, "observer_readonly", frame.id); // E16
      return;
    }
    const target = state.peers.get(to);
    const knownOnline = target !== undefined && target.helloDone && !target.socket.destroyed;
    if (!knownOnline && !state.knownAliases.has(to)) {
      state.stats.refused += 1;
      sendError(from.socket, "peer_not_found", frame.id); // E4
      return;
    }
    if (knownOnline && target && !target.rooms.has(room)) {
      state.stats.refused += 1;
      sendError(from.socket, "not_member", frame.id);
      return;
    }

    // rate limits (E15): kind from priority
    const priority = frame.priority ?? "normal";
    const kind: RateKind = priority === "force" ? "force" : priority === "urgent" ? "urgent" : "msg";
    if (!checkRate(state, from.alias, kind, policy.rateLimits)) {
      state.stats.refused += 1;
      sendError(from.socket, "rate_limited", frame.id);
      return;
    }

    // declarative policy (D11)
    const decision = evaluatePolicy(policy, { from: from.alias, to, room, priority });
    let routedFrame = frame;
    let interruptStatus: string | undefined;
    if (decision.action === "deny") {
      state.stats.refused += 1;
      sendError(from.socket, decision.code, frame.id); // E14
      return;
    }
    if (decision.action === "downgrade") {
      routedFrame = { ...frame, priority: "urgent" };
      interruptStatus = "force_downgraded";
    } else if (priority === "force") {
      interruptStatus = "force_accepted";
    }

    if (knownOnline && target) {
      const t = target;
      // C5 fix: ack(delivered) ONLY after the write to the recipient socket succeeds.
      writeFrame(t.socket, routedFrame, config.maxFrameBytes, (ok) => {
        if (ok) {
          state.stats.relayed += 1;
          sendAck(from, frame.id, "delivered", interruptStatus);
        } else {
          // B2: identity guard — a re-hello may have replaced the record.
          if (state.peers.get(t.alias) === t) closePeer(state, t.alias, "write_failure");
          enqueueMailbox(state, config, t.alias, routedFrame);
          sendAck(from, frame.id, "queued_offline", interruptStatus);
        }
      });
    } else {
      // known offline alias → mailbox, THEN ack(queued_offline) (C5/I4, E5)
      enqueueMailbox(state, config, to, routedFrame);
      state.stats.relayed += 1;
      sendAck(from, frame.id, "queued_offline", interruptStatus);
    }
  };

  const routeOnlineOnly = (from: PeerRecord, frame: MeshFrame, silentDrop: boolean): void => {
    const to = frame.to;
    const target = to !== undefined ? state.peers.get(to) : undefined;
    if (target && target.helloDone && !target.socket.destroyed) {
      const t = target;
      writeFrame(t.socket, frame, config.maxFrameBytes, (ok) => {
        if (ok) {
          state.stats.relayed += 1;
          if (!silentDrop) sendAck(from, frame.id, "delivered");
        } else {
          // B2: identity guard — same stale-record hazard as routeMsg.
          if (state.peers.get(t.alias) === t) closePeer(state, t.alias, "write_failure");
          if (!silentDrop) sendAck(from, frame.id, "dropped_offline");
        }
      });
    } else if (!silentDrop) {
      // replies to offline targets: explicit honest status (§8 SendResult)
      sendAck(from, frame.id, "dropped_offline");
    }
    // reminds to offline targets: dropped silently (§7.3)
  };

  const dispatch = (socket: Socket, frame: MeshFrame): void => {
    const peer = frame.from !== undefined ? state.peers.get(frame.from) : undefined;
    const authed = peer !== undefined && peer.socket === socket && peer.helloDone;

    if (frame.type === "hello") {
      if (authed) {
        sendError(socket, "invalid_frame", frame.id); // already claimed
        return;
      }
      handleHello(socket, frame);
      return;
    }
    if (!authed || !peer) {
      sendError(socket, "hello_required", frame.id); // only hello allowed pre-welcome
      return;
    }
    peer.lastSeenAt = Date.now();

    switch (frame.type) {
      case "msg":
        routeMsg(peer, frame);
        break;
      case "reply":
        routeOnlineOnly(peer, frame, false);
        break;
      case "remind":
        routeOnlineOnly(peer, frame, true);
        break;
      case "ping":
        sendTo(peer, buildFrame({ type: "pong", id: frame.id }));
        break;
      case "status_req": {
        sendTo(
          peer,
          buildFrame({
            type: "status_res",
            id: frame.id,
            peers: peersSnapshot(state, frame.room),
            rooms: [...state.rooms.keys()],
          }),
        );
        break;
      }
      case "join": {
        if (frame.room === undefined) {
          sendError(socket, "invalid_room", frame.id);
          break;
        }
        const res = joinRoom(state, config, peer, frame.room, frame.role ?? "member");
        if (res.ok) {
          sendAck(peer, frame.id, "ok");
          broadcastToRoom(
            state,
            frame.room,
            presenceFrame(peer.alias, "online", frame.room),
            peer.alias,
            sendTo,
          );
        } else {
          sendError(socket, res.code, frame.id);
        }
        break;
      }
      case "leave": {
        if (frame.room === undefined) {
          sendError(socket, "invalid_room", frame.id);
          break;
        }
        const res = leaveRoom(state, peer, frame.room);
        if (res.ok) sendAck(peer, frame.id, "ok");
        else sendError(socket, res.code, frame.id);
        break;
      }
      default:
        sendError(socket, "invalid_frame", frame.id);
    }
  };

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const decoder = new FrameDecoder(config.maxFrameBytes);
    // handshake bound: hello ≤ 5 s (§6.1)
    const helloTimer = setTimeout(() => {
      sendError(socket, "timeout");
      socket.destroy();
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    socket.on("data", (chunk) => {
      let lines: string[];
      try {
        lines = decoder.push(chunk);
      } catch (err) {
        if (err instanceof FrameSizeError) {
          sendError(socket, "oversized"); // E11: oversized + close
          socket.destroy();
          return;
        }
        throw err;
      }
      for (const line of lines) {
        const parsed = parseFrameLine(line);
        if (!parsed.ok) {
          sendError(socket, parsed.code);
          if (parsed.code === "invalid_alias" || parsed.code === "invalid_frame") continue;
          continue;
        }
        // any valid frame clears the handshake deadline once hello done
        dispatch(socket, parsed.frame);
        const p = parsed.frame.from !== undefined ? state.peers.get(parsed.frame.from) : undefined;
        if (p && p.socket === socket && p.helloDone) clearTimeout(helloTimer);
        if (parsed.frame.type === "hello") clearTimeout(helloTimer);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(helloTimer);
      for (const peer of [...state.peers.values()]) {
        if (peer.socket === socket) closePeer(state, peer.alias, "socket_closed");
      }
    });
  });

  // silence sweep: destroy sockets silent > brokerSilenceMs (§7.6 — only sweep, on sockets)
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const peer of [...state.peers.values()]) {
      if (peer.helloDone && now - peer.lastSeenAt > config.brokerSilenceMs) {
        peer.socket.destroy(); // close event → closePeer
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  const mailboxPurge = setInterval(() => purgeAllExpired(state, config), MAILBOX_PURGE_INTERVAL_MS);
  mailboxPurge.unref();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      server.removeListener("error", reject);
      resolve({
        server,
        state,
        socketPath: sockPath,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(sweep);
            clearInterval(mailboxPurge);
            for (const peer of state.peers.values()) peer.socket.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

/** Purge tables + presence(offline) to former room members (§6.8 peer FSM). */
export function closePeer(
  state: BrokerState,
  alias: string,
  _reason: string,
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
): void {
  const peer = state.peers.get(alias);
  if (!peer) return;
  const roomIds = detachFromRooms(state, peer);
  state.peers.delete(alias);
  if (!peer.socket.destroyed) peer.socket.destroy();
  for (const roomId of roomIds) {
    broadcastToRoom(
      state,
      roomId,
      presenceFrame(alias, "offline", roomId),
      alias,
      (p, f) => {
        // B4: same writeFrame discipline as every other write (bounded,
        // encoded); fire-and-forget — broadcast failures are swallowed.
        writeFrame(p.socket, f, maxFrameBytes, () => {});
      },
    );
  }
}

// ---- standalone main (§7.4): lock, bind, signals ----

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** B3: post-write confirmation — the lock must contain OUR pid. */
function lockHeldByUs(lockPath: string): boolean {
  try {
    return Number(readFileSync(lockPath, "utf8").trim()) === process.pid;
  } catch {
    return false;
  }
}

/** Acquire lock, stale-pid tolerant (E20). Returns false if a live broker holds it. */
export function acquireLock(dir: string): boolean {
  mkdirSync(dir, { recursive: true });
  const lockPath = brokerLockPath(dir);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      // B3: wx-create is atomic, but a concurrent stale-takeover can unlink +
      // rewrite between our write and our next step — re-read and confirm the
      // lock carries OUR pid before proceeding; retry the loop if we lost.
      if (lockHeldByUs(lockPath)) return true;
      continue;
    } catch {
      // exists: check staleness
    }
    try {
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) return false;
    } catch {
      // unreadable → treat as stale
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // gone already
    }
  }
  return false;
}

/** B3: connect probe — true if a live broker answers on the socket path. */
function probeSocketAlive(sockPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function main(): Promise<void> {
  const dir = runtimeDir();
  const sDir = stateDir();
  mkdirSync(dir, { recursive: true });
  if (!acquireLock(dir)) {
    process.stderr.write("mesh broker: lock held by a live process\n");
    process.exit(1);
  }
  const sockPath = brokerSocketPath(dir);
  if (existsSync(sockPath)) {
    // B3: probe before unlink — never hijack a live broker's socket. Only a
    // dead/stale socket path may be removed.
    if (await probeSocketAlive(sockPath)) {
      process.stderr.write("mesh broker: socket path served by a live broker\n");
      process.exit(1);
    }
    try {
      unlinkSync(sockPath);
    } catch {
      // best effort
    }
  }
  const config = loadConfig(sDir);
  const policy = loadPolicy(sDir);
  const broker = await createBroker({ config, policy, socketPath: sockPath });

  const shutdown = (): void => {
    void broker.close().finally(() => {
      try {
        unlinkSync(sockPath);
      } catch {
        // already gone
      }
      try {
        unlinkSync(brokerLockPath(dir));
      } catch {
        // already gone
      }
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdout.write(`mesh broker up pid=${process.pid} sock=${sockPath}\n`);
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`mesh broker fatal: ${String(err)}\n`);
    process.exit(1);
  });
}
