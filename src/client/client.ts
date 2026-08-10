// client/client.ts — MeshClient: connect/send/reply/status/join/leave/close (§8).
// Pi-independent (I9): emits events; the extension adapter consumes them.
import { EventEmitter } from "node:events";
import net, { type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import {
  buildFrame,
  isValidAlias,
  isValidRefPath,
  isValidReservationPattern,
  isValidRoom,
  normalizeAlias,
  parseFrameLine,
  type FileReservation,
  type MeshFrame,
  type MeshPeerInfo,
  type MeshPriority,
  type MeshRole,
} from "../protocol/envelope.js";
import { encodeFrame, FrameDecoder, sha256 } from "../protocol/frames.js";
import {
  ACK_TIMEOUT_MS,
  ALIAS_RAND_CHARS,
  DEFAULT_AWAIT_REPLY_TIMEOUT_MS,
  DEFAULT_CONFIG,
  DEFAULT_ROOM,
  HELLO_TIMEOUT_MS,
  MAX_AWAIT_REPLY_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REFS,
  MIN_AWAIT_REPLY_TIMEOUT_MS,
  OUTBOX_FLUSH_CAP,
  STATUS_REQ_TIMEOUT_MS,
  TRANSCRIPT_RING_SIZE,
  type MeshConfig,
} from "../shared/config.js";
import { runtimeDir } from "../shared/paths.js";
import { PendingReplies } from "./pending.js";
import { backoffMs, ensureBroker } from "./reconnect.js";

export interface WelcomeInfo {
  alias: string;
  rooms: string[];
  peers: MeshPeerInfo[];
  mailboxCount: number;
}

export interface StatusSnapshot {
  peers: MeshPeerInfo[];
  rooms: string[];
}

export interface SendOpts {
  to: string;
  message: string;
  room?: string;
  priority?: MeshPriority;
  reason?: string; // force only — hashed, never persisted (§6.6)
  awaitReply?: boolean;
  timeoutMs?: number;
  refs?: string[];
}

export type SendResult =
  | { status: "delivered"; msgId: string }
  | { status: "queued_offline"; msgId: string }
  | { status: "reply"; msgId: string; response: string; outputHash: string }
  | { status: "expired" | "blocked" | "error"; msgId?: string; reason: string };

export interface MeshClientOpts {
  alias?: string;
  rooms?: string[];
  runtimeDir?: string;
  config?: Partial<MeshConfig>;
  onFrame?: (f: MeshFrame) => void;
  /** Disable auto-reconnect (ephemeral CLI clients). */
  noReconnect?: boolean;
}

interface AckWaiter {
  resolve: (frame: MeshFrame) => void;
  timer: NodeJS.Timeout;
}

const BLOCKED_CODES = new Set([
  "policy_denied",
  "rate_limited",
  "peer_not_found",
  "not_member",
  "observer_readonly",
  "force_requires_reason",
]);

function defaultAlias(): string {
  return `agent-${randomBytes(ALIAS_RAND_CHARS / 2).toString("hex").slice(0, ALIAS_RAND_CHARS)}`;
}

export class MeshClient extends EventEmitter {
  readonly alias: string;
  private readonly initialRooms: string[];
  private readonly runtimeDir: string;
  private readonly config: MeshConfig;
  private readonly noReconnect: boolean;

  private socket: Socket | null = null;
  private online = false;
  private intentionallyClosed = false;
  private connecting: Promise<WelcomeInfo> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;

  private readonly ackWaiters = new Map<string, AckWaiter>();
  private readonly statusWaiters = new Map<string, AckWaiter>();
  private readonly outbox: MeshFrame[] = [];
  private readonly inbox = new Map<string, MeshFrame>(); // msgId → inbound msg (mesh_reply target)
  private readonly awaitTargets = new Map<string, { to: string; room: string }>();
  private readonly pending: PendingReplies;
  /** Memory-only ring buffer of last frames (bodies included) for mesh_history (§8). */
  readonly transcript: MeshFrame[] = [];
  /** Own file reservations (D21) — declared at hello, updated via reserve/release. */
  private ownReservations: FileReservation[] = [];
  /** Latest known reservations per peer, fed by welcome/reserve broadcasts. */
  private readonly peerReservations = new Map<string, FileReservation[]>();

  constructor(opts: MeshClientOpts = {}) {
    super();
    this.alias = normalizeAlias(opts.alias ?? defaultAlias());
    this.initialRooms = opts.rooms ?? [...DEFAULT_CONFIG.rooms];
    this.runtimeDir = opts.runtimeDir ?? runtimeDir();
    this.config = { ...DEFAULT_CONFIG, ...opts.config, rooms: this.initialRooms };
    this.noReconnect = opts.noReconnect === true;
    if (opts.onFrame) this.on("frame", opts.onFrame);
    this.pending = new PendingReplies((msgId) => this.sendRemind(msgId));
  }

  isOnline(): boolean {
    return this.online;
  }

  /** Additive (HUD): number of live awaitReply pendings. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Additive read-only peek at an inbound frame by msgId (ledger enrichment).
   * NEVER mutates the inbox — callers rely on it surviving for future replies.
   */
  peekInbox(msgId: string): MeshFrame | undefined {
    return this.inbox.get(msgId);
  }

  // ---- file reservations (D21) ----

  /** This client's reservations (live, mutable by reserve/release). */
  get reservations(): readonly FileReservation[] {
    return this.ownReservations;
  }

  /** Known reservations of a peer alias (from welcome/status/reserve broadcasts). */
  reservationsOf(alias: string): readonly FileReservation[] {
    return this.peerReservations.get(alias) ?? [];
  }

  /** Snapshot of every peer alias currently holding reservations. */
  get peerReservationAliases(): readonly string[] {
    return [...this.peerReservations.keys()];
  }

  /** Live peer→reservations map (read-only view, includes self). */
  get peerReservationMap(): ReadonlyMap<string, readonly FileReservation[]> {
    return this.peerReservations;
  }

  private setOwnReservations(next: FileReservation[]): void {
    this.ownReservations = next;
    this.peerReservations.set(this.alias, next);
  }

  private applyPeerReservations(alias: string, reservations: FileReservation[] | undefined): void {
    if (reservations !== undefined && reservations.length > 0) {
      this.peerReservations.set(alias, [...reservations]);
    } else {
      this.peerReservations.delete(alias);
    }
  }

  private ring(frame: MeshFrame): void {
    this.transcript.push(frame);
    if (this.transcript.length > TRANSCRIPT_RING_SIZE) {
      this.transcript.splice(0, this.transcript.length - TRANSCRIPT_RING_SIZE);
    }
  }

  // ---- connection lifecycle ----

  connect(): Promise<WelcomeInfo> {
    if (this.online && this.socket) {
      return Promise.resolve({
        alias: this.alias,
        rooms: this.initialRooms,
        peers: [],
        mailboxCount: 0,
      });
    }
    // explicit connect re-arms auto-reconnect after a prior close()
    this.intentionallyClosed = false;
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<WelcomeInfo> {
    const sockPath = await ensureBroker(this.runtimeDir); // throws broker_unavailable (I10)
    const socket = net.createConnection(sockPath);
    this.socket = socket;
    const decoder = new FrameDecoder(this.config.maxFrameBytes);

    const welcome = await new Promise<WelcomeInfo>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(this.helloTimer ?? undefined);
        socket.destroy();
        reject(new Error(reason));
      };
      this.helloTimer = setTimeout(() => fail("timeout: hello handshake"), HELLO_TIMEOUT_MS);
      this.helloTimer.unref();

      socket.once("connect", () => {
        const hello = buildFrame({
          type: "hello",
          from: this.alias,
          rooms: [...this.initialRooms],
          reservations: this.ownReservations.length > 0 ? [...this.ownReservations] : undefined,
        });
        socket.write(encodeFrame(hello, this.config.maxFrameBytes));
      });
      socket.once("error", () => fail("broker_unavailable"));
      socket.on("data", (chunk) => {
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch {
          fail("oversized");
          return;
        }
        for (const line of lines) {
          const parsed = parseFrameLine(line);
          if (!parsed.ok) continue;
          const frame = parsed.frame;
          if (!settled) {
            if (frame.type === "welcome") {
              settled = true;
              clearTimeout(this.helloTimer ?? undefined);
              this.online = true;
              this.reconnectAttempt = 0;
              this.attachSocket(socket, decoder);
              // D21: seed the peer reservation cache from the welcome snapshot
              for (const p of frame.peers ?? []) this.applyPeerReservations(p.alias, p.reservations);
              resolve({
                alias: this.alias,
                rooms: frame.rooms ?? [...this.initialRooms],
                peers: frame.peers ?? [],
                mailboxCount: frame.mailboxCount ?? 0,
              });
            } else if (frame.type === "error") {
              fail(frame.code ?? "internal");
            }
          } else {
            this.onFrame(frame);
          }
        }
      });
      socket.on("close", () => {
        if (!settled) fail("broker_unavailable");
      });
    });

    this.startHeartbeat();
    this.flushOutbox();
    this.emit("ready", welcome);
    return welcome;
  }

  /** Post-handshake wiring: frames dispatched, close → reconnect w/ backoff. */
  private attachSocket(socket: Socket, _decoder: FrameDecoder): void {
    socket.on("close", () => this.onSocketClosed());
    socket.on("error", () => {});
  }

  private onSocketClosed(): void {
    const wasOnline = this.online;
    this.online = false;
    this.socket = null;
    this.stopHeartbeat();
    // in-flight sends: honest error, never delivered (E2, §7.5)
    for (const [id, w] of this.ackWaiters) {
      clearTimeout(w.timer);
      w.resolve(
        buildFrame({ type: "error", code: "internal", id, status: "connection_lost" }),
      );
    }
    this.ackWaiters.clear();
    for (const [id, w] of this.statusWaiters) {
      clearTimeout(w.timer);
      w.resolve(buildFrame({ type: "error", code: "internal", id }));
    }
    this.statusWaiters.clear();
    if (this.intentionallyClosed || this.noReconnect) {
      if (wasOnline) this.emit("closed");
      return;
    }
    // backoff 250ms ×2^n cap 5s → ensureBroker → re-hello (§6.8, §7.5)
    const delay = backoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
        // ensureBroker/connect failed → onSocketClosed not called (no socket);
        // schedule next attempt via the same backoff path.
        this.onSocketClosed();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private onFrame(frame: MeshFrame): void {
    this.ring(frame);
    switch (frame.type) {
      case "ack": {
        const w = this.ackWaiters.get(frame.id);
        if (w) {
          this.ackWaiters.delete(frame.id);
          clearTimeout(w.timer);
          w.resolve(frame);
        }
        break;
      }
      case "status_res": {
        const w = this.statusWaiters.get(frame.id);
        if (w) {
          this.statusWaiters.delete(frame.id);
          clearTimeout(w.timer);
          w.resolve(frame);
        }
        break;
      }
      case "msg":
      case "mailbox":
        if (frame.id) this.inbox.set(frame.id, frame);
        this.emit("inbound", frame);
        break;
      case "reserve": {
        // D21: full-state replacement broadcast (empty array = released)
        const alias = frame.from;
        if (alias !== undefined && alias !== this.alias) {
          this.applyPeerReservations(alias, frame.reservations);
          this.emit("reservations", { from: alias, reservations: frame.reservations ?? [] });
        }
        break;
      }
      case "remind":
        this.emit("inbound", frame);
        break;
      case "reply": {
        const matched = this.pending.handleReply(frame);
        if (matched) this.emit("reply", frame);
        break;
      }
      case "presence":
        if (frame.status === "offline") this.peerReservations.delete(frame.from ?? "");
        this.emit("presence", frame);
        break;
      case "pong":
        break;
      case "error": {
        // broker refusals carry the original frame id → resolve the waiter (§5 flow)
        const w = this.ackWaiters.get(frame.id);
        if (w) {
          this.ackWaiters.delete(frame.id);
          clearTimeout(w.timer);
          w.resolve(frame);
        }
        const sw = this.statusWaiters.get(frame.id);
        if (sw) {
          this.statusWaiters.delete(frame.id);
          clearTimeout(sw.timer);
          sw.resolve(frame);
        }
        this.emit("frame", frame);
        return; // skip double-emit below
      }
      default:
        break;
    }
    this.emit("frame", frame);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.online && this.socket && !this.socket.destroyed) {
        this.socket.write(
          encodeFrame(buildFrame({ type: "ping", from: this.alias }), this.config.maxFrameBytes),
        );
      }
    }, this.config.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private flushOutbox(): void {
    const n = Math.min(this.outbox.length, OUTBOX_FLUSH_CAP);
    for (let i = 0; i < n; i += 1) {
      const frame = this.outbox.shift();
      if (frame && this.socket && !this.socket.destroyed) {
        this.socket.write(encodeFrame(frame, this.config.maxFrameBytes));
      }
    }
  }

  private writeOrQueue(frame: MeshFrame): void {
    if (this.online && this.socket && !this.socket.destroyed) {
      this.socket.write(encodeFrame(frame, this.config.maxFrameBytes));
    } else if (this.outbox.length < OUTBOX_FLUSH_CAP) {
      this.outbox.push(frame);
    }
  }

  // ---- send / reply ----

  async send(opts: SendOpts): Promise<SendResult> {
    const to = normalizeAlias(opts.to);
    if (!isValidAlias(to)) return { status: "error", reason: "invalid_alias" };
    if (to === this.alias) return { status: "blocked", reason: "self_send" };
    const room = opts.room ?? DEFAULT_ROOM;
    if (!isValidRoom(room)) return { status: "error", reason: "invalid_room" };
    if (Buffer.byteLength(opts.message, "utf8") > MAX_BODY_BYTES) {
      return { status: "error", reason: "invalid_frame: body too large" }; // E10
    }
    if (opts.refs !== undefined) {
      if (opts.refs.length > MAX_REFS || !opts.refs.every(isValidRefPath)) {
        return { status: "error", reason: "invalid_frame: bad refs" }; // E22
      }
    }
    const priority = opts.priority ?? "normal";
    if (priority === "force" && (opts.reason === undefined || opts.reason.trim() === "")) {
      return { status: "error", reason: "force_requires_reason" }; // E13
    }
    const timeoutMs = Math.min(
      MAX_AWAIT_REPLY_TIMEOUT_MS,
      Math.max(MIN_AWAIT_REPLY_TIMEOUT_MS, opts.timeoutMs ?? DEFAULT_AWAIT_REPLY_TIMEOUT_MS),
    );

    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { status: "blocked", reason: "broker_unavailable" }; // E1, I10
      }
    }

    const expiresAt = opts.awaitReply ? new Date(Date.now() + timeoutMs).toISOString() : undefined;
    const frame = buildFrame({
      type: "msg",
      from: this.alias,
      to,
      room,
      priority,
      body: opts.message,
      refs: opts.refs,
      reasonHash: priority === "force" ? sha256(opts.reason ?? "") : undefined,
      expiresAt,
    });

    // register pending BEFORE write to avoid a reply/registration race
    let pendingPromise: Promise<import("./pending.js").PendingResolution> | null = null;
    if (opts.awaitReply) {
      this.awaitTargets.set(frame.id, { to, room });
      pendingPromise = this.pending.register(frame.id, Date.now() + timeoutMs);
    }

    const ackPromise = this.waitAck(frame.id);
    this.writeOrQueue(frame);
    this.ring(frame);
    const ack = await ackPromise;

    if (ack.type === "error") {
      if (opts.awaitReply) {
        this.pending.cancel(frame.id, ack.code ?? "error");
        this.awaitTargets.delete(frame.id);
      }
      const code = ack.code ?? "internal";
      if (BLOCKED_CODES.has(code)) return { status: "blocked", msgId: frame.id, reason: code };
      return { status: "error", msgId: frame.id, reason: code };
    }

    if (!opts.awaitReply || pendingPromise === null) {
      if (ack.status === "delivered") return { status: "delivered", msgId: frame.id };
      if (ack.status === "queued_offline") return { status: "queued_offline", msgId: frame.id };
      // N2: an unknown/unexpected ack status (e.g. dropped_offline on a msg)
      // is an honest error — never misreported as delivered.
      return {
        status: "error",
        msgId: frame.id,
        reason: `unexpected_ack_status: ${ack.status ?? "missing"}`,
      };
    }

    const resolution = await pendingPromise;
    this.awaitTargets.delete(frame.id);
    if (resolution.kind === "reply" && resolution.frame) {
      return {
        status: "reply",
        msgId: frame.id,
        response: resolution.frame.body ?? "",
        outputHash: resolution.frame.bodyHash ?? "",
      };
    }
    if (resolution.kind === "expired") {
      this.emit("expired", { msgId: frame.id });
      return { status: "expired", msgId: frame.id, reason: "expired" };
    }
    return { status: "error", msgId: frame.id, reason: resolution.reason ?? "error" };
  }

  async reply(msgId: string, body: string, refs?: string[]): Promise<SendResult> {
    const original = this.inbox.get(msgId);
    if (!original || original.from === undefined) {
      return { status: "error", msgId, reason: "reply_without_target" }; // E9
    }
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return { status: "error", msgId, reason: "invalid_frame: body too large" };
    }
    if (refs !== undefined && (refs.length > MAX_REFS || !refs.every(isValidRefPath))) {
      return { status: "error", msgId, reason: "invalid_frame: bad refs" };
    }
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { status: "blocked", msgId, reason: "broker_unavailable" };
      }
    }
    const frame = buildFrame({
      type: "reply",
      from: this.alias,
      to: original.from,
      room: original.room,
      replyTo: msgId,
      body,
      refs,
    });
    const ackPromise = this.waitAck(frame.id);
    this.writeOrQueue(frame);
    this.ring(frame);
    const ack = await ackPromise;
    if (ack.type === "error") {
      return { status: "error", msgId: frame.id, reason: ack.code ?? "internal" };
    }
    if (ack.status === "dropped_offline") {
      return { status: "error", msgId: frame.id, reason: "dropped_offline" };
    }
    return { status: "delivered", msgId: frame.id };
  }

  /** D8: client-side remind, broker stays mute. Max 2 enforced by PendingReplies. */
  private sendRemind(msgId: string): void {
    const target = this.awaitTargets.get(msgId);
    if (!target) return;
    const frame = buildFrame({
      type: "remind",
      id: msgId,
      from: this.alias,
      to: target.to,
      room: target.room,
      replyTo: msgId,
      body: `reminder: reply expected for ${msgId}`,
    });
    this.writeOrQueue(frame);
    this.ring(frame);
  }

  /**
   * D21: (re)declare this client's file reservations (add or replace).
   * The broker broadcasts the new full state to every peer. Patterns that are
   * invalid or empty are rejected before the network round-trip.
   */
  async reserve(patterns: string[], reason?: string): Promise<SendResult> {
    const valid: string[] = [];
    for (const raw of patterns) {
      const pattern = raw.trim();
      if (pattern.length === 0 || !isValidReservationPattern(pattern)) {
        return { status: "error", reason: `invalid_pattern: ${raw.slice(0, 80)}` };
      }
      valid.push(pattern);
    }
    if (valid.length === 0) return { status: "error", reason: "invalid_pattern" };
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { status: "blocked", reason: "broker_unavailable" };
      }
    }
    const merged = [...this.ownReservations];
    for (const pattern of valid) {
      const idx = merged.findIndex((r) => r.pattern === pattern);
      const entry: FileReservation = {
        pattern,
        reason: reason !== undefined && reason.trim() !== "" ? reason.trim().slice(0, 512) : undefined,
        since: new Date().toISOString(),
      };
      if (idx !== -1) merged[idx] = entry;
      else merged.push(entry);
    }
    const frame = buildFrame({ type: "reserve", from: this.alias, reservations: merged });
    const ack = await this.roundTrip(frame);
    if (ack.type === "error") return { status: "error", reason: ack.code ?? "internal" };
    this.setOwnReservations(merged);
    this.emit("reservations", { from: this.alias, reservations: merged });
    return { status: "delivered", msgId: frame.id };
  }

  /**
   * D21: release reservations. `patterns` undefined → release ALL.
   * Returns the released patterns.
   */
  async release(patterns?: string[]): Promise<{ released: string[] } & SendResult> {
    const releasing = patterns === undefined
      ? this.ownReservations.map((r) => r.pattern)
      : patterns.map((p) => p.trim()).filter((p) => p.length > 0);
    if (releasing.length === 0) return { status: "delivered", msgId: "", released: [] };
    const merged = this.ownReservations.filter((r) => !releasing.includes(r.pattern));
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { status: "blocked", reason: "broker_unavailable", released: [] };
      }
    }
    const frame = buildFrame({ type: "reserve", from: this.alias, reservations: merged });
    const ack = await this.roundTrip(frame);
    if (ack.type === "error") return { status: "error", reason: ack.code ?? "internal", released: [] };
    this.setOwnReservations(merged);
    this.emit("reservations", { from: this.alias, reservations: merged });
    return { status: "delivered", msgId: frame.id, released: releasing };
  }

  private waitAck(id: string): Promise<MeshFrame> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(id);
        resolve(buildFrame({ type: "error", code: "timeout", id }));
      }, ACK_TIMEOUT_MS);
      timer.unref();
      this.ackWaiters.set(id, { resolve, timer });
    });
  }

  // ---- status / rooms / close ----

  status(room?: string): Promise<StatusSnapshot> {
    return new Promise((resolve) => {
      if (!this.online) {
        resolve({ peers: [], rooms: [] });
        return;
      }
      const frame = buildFrame({ type: "status_req", from: this.alias, room });
      const timer = setTimeout(() => {
        this.statusWaiters.delete(frame.id);
        resolve({ peers: [], rooms: [] });
      }, STATUS_REQ_TIMEOUT_MS);
      timer.unref();
      this.statusWaiters.set(frame.id, {
        timer,
        resolve: (res) =>
          resolve({ peers: res.peers ?? [], rooms: res.rooms ?? [] }),
      });
      this.writeOrQueue(frame);
    });
  }

  async join(room: string, role: MeshRole = "member"): Promise<void> {
    const frame = buildFrame({ type: "join", from: this.alias, room, role });
    const ack = await this.roundTrip(frame);
    if (ack.type === "error") throw new Error(ack.code ?? "internal");
  }

  async leave(room: string): Promise<void> {
    const frame = buildFrame({ type: "leave", from: this.alias, room });
    const ack = await this.roundTrip(frame);
    if (ack.type === "error") throw new Error(ack.code ?? "internal");
  }

  private async roundTrip(frame: MeshFrame): Promise<MeshFrame> {
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return buildFrame({ type: "error", code: "shutting_down", id: frame.id });
      }
    }
    const ackPromise = this.waitAck(frame.id);
    this.writeOrQueue(frame);
    return ackPromise;
  }

  async close(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.pending.cancelAll("shutting_down"); // E23
    const socket = this.socket;
    this.socket = null;
    this.online = false;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
        setTimeout(resolve, ACK_TIMEOUT_MS).unref();
      });
    }
    this.emit("closed");
  }
}
