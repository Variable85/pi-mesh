// client/client.ts — MeshClient: connect/send/reply/status/join/leave/close (§8).
// Pi-independent (I9): emits events; the extension adapter consumes them.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import tls from "node:tls";
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
  parseEndpoint,
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
  to?: string;
  message: string;
  room?: string;
  priority?: MeshPriority;
  reason?: string; // force only — hashed, never persisted (§6.6)
  awaitReply?: boolean;
  timeoutMs?: number;
  refs?: string[];
  /** D24: fan out to every room member (room required, to must be absent). */
  broadcast?: boolean;
}

export interface ReplyOpts {
  refs?: string[];
  /** D24: target a different member than the original sender. */
  to?: string;
  /** D24: fan the answer out to the whole room of the original message. */
  replyAll?: boolean;
}

export type SendResult =
  | { status: "delivered"; msgId: string; deliveredCount?: number; totalCount?: number }
  | { status: "queued_offline"; msgId: string; deliveredCount?: number; totalCount?: number }
  | { status: "reply"; msgId: string; response: string; outputHash: string }
  | { status: "expired" | "blocked" | "error"; msgId?: string; reason: string };

export function isBroadcastResult(res: SendResult): res is Extract<SendResult, { deliveredCount?: number }> {
  return res.status === "delivered" || res.status === "queued_offline";
}

// ---- D32: activity status ----

export interface PeerActivityStatus {
  status: "active" | "idle" | "stuck";
  idleFor?: string;
}

export function formatDurationShort(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * D32: activity status from the broker's lastSeenAt — idle after
 * activityIdleMs, STUCK when idle past activityStuckMs AND holding
 * reservations (a peer with claims that never progresses blocks others).
 */
export function computePeerStatus(
  lastSeenAt: string | undefined,
  hasReservations: boolean,
  idleMs: number,
  stuckMs: number,
  now: number = Date.now(),
): PeerActivityStatus {
  if (lastSeenAt === undefined) return { status: "active" };
  const t = Date.parse(lastSeenAt);
  if (Number.isNaN(t)) return { status: "active" };
  const elapsed = now - t;
  if (elapsed < idleMs) return { status: "active" };
  if (hasReservations && elapsed >= stuckMs) return { status: "stuck", idleFor: formatDurationShort(elapsed) };
  return { status: "idle", idleFor: formatDurationShort(elapsed) };
}

export interface MeshClientOpts {
  alias?: string;
  rooms?: string[];
  /** Reservations to declare at hello (persisted identity reload). */
  initialReservations?: FileReservation[];
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

/** alias_taken: retries of the original alias before falling back to random. */
const ALIAS_RETRY_ATTEMPTS = 4;
const ALIAS_RETRY_DELAY_MS = 250;

/** D25: a reply target stays "handled" for 30 min (duplicates dropped). */
const HANDLED_REPLY_WINDOW_MS = 1_800_000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

function defaultAlias(): string {
  return `agent-${randomBytes(ALIAS_RAND_CHARS / 2).toString("hex").slice(0, ALIAS_RAND_CHARS)}`;
}

export class MeshClient extends EventEmitter {
  /** Current alias — mutable via rename() (in-flight alias change). */
  private aliasInternal: string;
  private readonly initialRooms: string[];
  /** All rooms this client is (or will be) a member of — re-declared at hello. */
  private readonly joinedRooms: Set<string>;
  private readonly runtimeDir: string;
  private readonly config: MeshConfig;
  private readonly noReconnect: boolean;

  private socket: Socket | null = null;
  private online = false;
  private intentionallyClosed = false;
  private aliasFallbackDone = false;
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
  /** D34: msgIds we sent that have been READ by peers (read receipts). */
  private readonly readBy = new Map<string, { alias: string; at: string }>();
  /** Latest known reservations per peer, fed by welcome/reserve broadcasts. */
  private readonly peerReservations = new Map<string, FileReservation[]>();
  /**
   * replyTo msgIds already answered/handled (D25): the FIRST reply to a given
   * message is consumed (pending match) or injected (orphan); later replies
   * are deduped by (replyTo + body hash) — an EXACT re-send of an already
   * handled answer is dropped silently (agents re-answering on reminds), but
   * a DIFFERENT answer to the same msgId (e.g. an ack "reçue" then the final
   * report) is still delivered.
   */
  private readonly handledReplyTargets = new Map<string, number>();

  constructor(opts: MeshClientOpts = {}) {
    super();
    this.aliasInternal = normalizeAlias(opts.alias ?? defaultAlias());
    this.initialRooms = opts.rooms ?? [...DEFAULT_CONFIG.rooms];
    this.joinedRooms = new Set(this.initialRooms);
    this.runtimeDir = opts.runtimeDir ?? runtimeDir();
    this.config = { ...DEFAULT_CONFIG, ...opts.config, rooms: this.initialRooms };
    this.noReconnect = opts.noReconnect === true;
    if (opts.initialReservations !== undefined) {
      this.ownReservations = opts.initialReservations.map((r) => ({ ...r }));
    }
    if (opts.onFrame) this.on("frame", opts.onFrame);
    this.pending = new PendingReplies((msgId) => this.sendRemind(msgId));
  }

  get alias(): string {
    return this.aliasInternal;
  }

  /** All rooms this client is a member of (re-declared at every hello). */
  get rooms(): readonly string[] {
    return [...this.joinedRooms];
  }

  /** D32: activity status thresholds from config. */
  get activityIdleMs(): number {
    return this.config.activityIdleMs;
  }

  /** D34: who read a msgId we sent ({alias, at}) — from read receipts. */
  readsOf(msgId: string): { alias: string; at: string }[] {
    const r = this.readBy.get(msgId);
    return r !== undefined && r.alias !== this.alias ? [{ ...r }] : [];
  }

  /** D34: all read receipts we hold, newest first. */
  readReceipts(limit = 5): { msgId: string; alias: string; at: string }[] {
    return [...this.readBy.entries()]
      .reverse()
      .slice(0, limit)
      .map(([msgId, r]) => ({ msgId, alias: r.alias, at: r.at }));
  }

  /** D34: send a read receipt for an inbound msgId back to its sender. */
  sendRead(msgId: string, to: string): void {
    if (!this.online) return;
    const frame = buildFrame({ type: "read", from: this.alias, to, reads: msgId });
    this.writeOrQueue(frame);
    this.ring(frame);
  }

  get activityStuckMs(): number {
    return this.config.activityStuckMs;
  }

  /** D33: reservation TTL (0 = unlimited, I11). */
  get reservationTtlMs(): number {
    return this.config.reservationTtlMs;
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
    // D26: keep the ring USEFUL — heartbeats/acks (ping/pong/ack) flood it
    // (4 pongs/min) and push real messages (msg/reply/reserve/…) out in
    // minutes, so mesh_history only showed pongs. Only frames the session
    // cares about are kept.
    if (frame.type === "ping" || frame.type === "pong" || frame.type === "ack") return;
    this.transcript.push(frame);
    if (this.transcript.length > TRANSCRIPT_RING_SIZE) {
      this.transcript.splice(0, this.transcript.length - TRANSCRIPT_RING_SIZE);
    }
  }

  /** replies to the same msgId are deduped for this long (D25). */
  private pruneHandledReplyTargets(now: number = Date.now()): void {
    for (const [id, ts] of this.handledReplyTargets) {
      if (now - ts > HANDLED_REPLY_WINDOW_MS) this.handledReplyTargets.delete(id);
    }
  }

  /**
   * True when this EXACT answer (replyTo + body) was already consumed.
   * Marks the key on first sight so re-sends are dropped.
   */
  private isDuplicateReply(replyTo: string, body: string, now: number = Date.now()): boolean {
    const key = `${replyTo}|${sha256(body)}`;
    const ts = this.handledReplyTargets.get(key);
    if (ts !== undefined && now - ts < HANDLED_REPLY_WINDOW_MS) return true;
    this.handledReplyTargets.set(key, now);
    this.pruneHandledReplyTargets(now);
    return false;
  }

  /** Mark a reply target as consumed (after pending match or orphan inject). */
  private markReplyHandled(replyTo: string, body: string, now: number = Date.now()): void {
    this.handledReplyTargets.set(`${replyTo}|${sha256(body)}`, now);
    this.pruneHandledReplyTargets(now);
  }

  // ---- connection lifecycle ----

  connect(): Promise<WelcomeInfo> {
    if (this.online && this.socket) {
      return Promise.resolve({
        alias: this.alias,
        rooms: [...this.joinedRooms],
        peers: [],
        mailboxCount: 0,
      });
    }
    // explicit connect re-arms auto-reconnect after a prior close()
    this.intentionallyClosed = false;
    this.connecting ??= this.doConnectWithAliasFallback().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
   * doConnect, but on alias_taken: first RETRY the original alias with a
   * short backoff — the old connection may be mid-close (the /reload
   * handover, where session_shutdown and session_start are back-to-back).
   * Only after the retries fail (a genuinely live peer holds the alias,
   * e.g. a crashed session that never disconnected) fall back to a fresh
   * random alias instead of looping forever. Emits `alias_fallback` so the
   * extension can notify the user and persist the new identity.
   */
  private async doConnectWithAliasFallback(): Promise<WelcomeInfo> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.doConnect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("alias_taken")) throw err;
        if (attempt < ALIAS_RETRY_ATTEMPTS) {
          await sleepMs(ALIAS_RETRY_DELAY_MS * 2 ** attempt);
          continue;
        }
        if (this.aliasFallbackDone) throw err;
        this.aliasFallbackDone = true;
        const previous = this.aliasInternal;
        this.aliasInternal = defaultAlias();
        try {
          const welcome = await this.doConnect();
          this.emit("alias_fallback", { from: previous, to: this.aliasInternal });
          return welcome;
        } catch {
          this.aliasFallbackDone = false;
          throw err; // surface the original alias_taken
        }
      }
    }
  }

  private async doConnect(): Promise<WelcomeInfo> {
    // D37: explicit broker URL (tcp/tls/unix) → connect there; otherwise the
    // local auto-spawned broker (ensureBroker).
    const endpoint = this.config.brokerUrl !== undefined ? parseEndpoint(this.config.brokerUrl) : null;
    let socket: Socket;
    if (endpoint !== null && (endpoint.kind === "tcp" || endpoint.kind === "tls")) {
      const opts = {
        host: endpoint.host,
        port: endpoint.port,
        ...(endpoint.kind === "tls"
          ? {
              ca: this.config.tlsCa !== undefined ? readFileSync(this.config.tlsCa) : undefined,
              rejectUnauthorized: this.config.tlsInsecure === true ? false : undefined,
            }
          : {}),
      };
      socket = endpoint.kind === "tls" ? tls.connect(opts) : net.createConnection(opts);
    } else if (endpoint !== null && endpoint.kind === "unix") {
      socket = net.createConnection(endpoint.path);
    } else {
      const sockPath = await ensureBroker(this.runtimeDir); // throws broker_unavailable (I10)
      socket = net.createConnection(sockPath);
    }
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
          rooms: [...this.joinedRooms],
          reservations: this.ownReservations.length > 0 ? [...this.ownReservations] : undefined,
          token: this.config.brokerToken !== undefined ? sha256(this.config.brokerToken) : undefined,
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
                rooms: frame.rooms ?? [...this.joinedRooms],
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
    // An explicit connect() is in flight — it owns the socket lifecycle.
    // Ignore stale closes from sockets we have already replaced (rename path).
    if (this.connecting) return;
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
        const replyTo = frame.replyTo;
        const body = frame.body ?? "";
        const matched = replyTo !== undefined ? this.pending.handleReply(frame) : false;
        if (matched) {
          // awaited reply — the send() promise already carries the answer
          if (replyTo !== undefined) this.markReplyHandled(replyTo, body);
          this.emit("reply", frame);
        } else if (replyTo !== undefined && this.isDuplicateReply(replyTo, body)) {
          // D25: this EXACT answer (same msgId + same body) was already
          // consumed (awaitReply) or injected (orphan) — a re-send on a
          // remind. Drop it silently. Different answers to the same msgId
          // (ack then final report) are NOT duplicates and still pass.
          this.pending.unmatchedReplyCount += 1;
        } else {
          // ORPHAN reply: the sender did not awaitReply, so no pending
          // exists — but the answer must still reach the session. Surface it
          // like an inbound frame (stored in the inbox so it can itself be
          // replied to). Without this, mesh_reply returned "delivered" yet
          // the sender never saw the response.
          if (replyTo !== undefined) this.markReplyHandled(replyTo, body);
          if (frame.id) this.inbox.set(frame.id, frame);
          this.emit("inbound", frame);
        }
        break;
      }
      case "read": {
        // D34: read receipt for one of our msgIds — tracked, no turn.
        const msgId = frame.reads;
        if (msgId !== undefined && frame.from !== undefined) {
          this.readBy.set(msgId, { alias: frame.from, at: frame.ts });
        }
        this.emit("read", frame);
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
    const broadcast = opts.broadcast === true;
    const to = opts.to !== undefined ? normalizeAlias(opts.to) : undefined;
    if (broadcast) {
      // D24: broadcast needs a room and must NOT carry a target
      if (to !== undefined) return { status: "error", reason: "broadcast_with_to" };
    } else {
      if (to === undefined || !isValidAlias(to)) return { status: "error", reason: "invalid_alias" };
      if (to === this.alias) return { status: "blocked", reason: "self_send" };
    }
    // Room resolution: explicit room wins; otherwise prefer "default" when
    // still joined, else the first joined room (the client may have left
    // "default" — sending into it would be refused as not_member).
    const room = opts.room ?? (this.joinedRooms.has(DEFAULT_ROOM)
      ? DEFAULT_ROOM
      : [...this.joinedRooms][0]);
    if (room === undefined || !isValidRoom(room)) {
      return { status: "error", reason: "not_in_any_room" };
    }
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
      broadcast: broadcast ? true : undefined,
      reasonHash: priority === "force" ? sha256(opts.reason ?? "") : undefined,
      expiresAt,
    });

    // register pending BEFORE write to avoid a reply/registration race
    let pendingPromise: Promise<import("./pending.js").PendingResolution> | null = null;
    if (opts.awaitReply) {
      this.awaitTargets.set(frame.id, { to: to ?? "*", room });
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
      if (ack.status === "delivered") {
        return {
          status: "delivered",
          msgId: frame.id,
          deliveredCount: ack.deliveredCount,
          totalCount: ack.totalCount,
        };
      }
      if (ack.status === "queued_offline") {
        return {
          status: "queued_offline",
          msgId: frame.id,
          deliveredCount: ack.deliveredCount,
          totalCount: ack.totalCount,
        };
      }
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

  async reply(msgId: string, body: string, opts: ReplyOpts = {}): Promise<SendResult> {
    const original = this.inbox.get(msgId);
    if (!original || original.from === undefined) {
      return { status: "error", msgId, reason: "reply_without_target" }; // E9
    }
    const { refs, to, replyAll } = opts;
    if (replyAll === true && to !== undefined) {
      return { status: "error", msgId, reason: "reply_all_with_to" };
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
    // D24 reply variants:
    //  - default: to the original sender (1:1, I5)
    //  - to=<alias>: targeted at another member of the conversation
    //  - replyAll: fan out to the whole room of the original message
    const target = replyAll === true ? undefined : to !== undefined ? normalizeAlias(to) : original.from;
    if (replyAll !== true && (target === undefined || !isValidAlias(target))) {
      return { status: "error", msgId, reason: "invalid_alias" };
    }
    const frame = buildFrame({
      type: "reply",
      from: this.alias,
      to: target,
      room: original.room,
      replyTo: msgId,
      body,
      refs,
      replyAll: replyAll === true ? true : undefined,
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
    return {
      status: "delivered",
      msgId: frame.id,
      deliveredCount: ack.deliveredCount,
      totalCount: ack.totalCount,
    };
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
    this.joinedRooms.add(room);
  }

  async leave(room: string): Promise<void> {
    const frame = buildFrame({ type: "leave", from: this.alias, room });
    const ack = await this.roundTrip(frame);
    if (ack.type === "error") {
      if (ack.code === "not_member") {
        // Resync: the broker does not know us in this room — make sure a
        // future reconnect does not try to rejoin it.
        this.joinedRooms.delete(room);
      }
      throw new Error(ack.code ?? "internal");
    }
    this.joinedRooms.delete(room);
  }

  /**
   * In-flight alias change: detach from the broker under the old alias, then
   * re-hello under the new one. Rooms and reservations are re-declared in the
   * hello (broker state for the old alias — rooms, reservations, mailbox — is
   * dropped with the connection). On failure (e.g. alias_taken) the previous
   * alias is restored and the session reconnects under it.
   * `unchanged: true` when the alias was already the requested one (no-op).
   */
  async rename(newAlias: string): Promise<
    | { ok: true; alias: string; unchanged?: boolean }
    | { ok: false; reason: string }
  > {
    const target = normalizeAlias(newAlias);
    if (!isValidAlias(target)) return { ok: false, reason: "invalid_alias" };
    if (target === this.aliasInternal) return { ok: true, alias: target, unchanged: true };
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { ok: false, reason: "broker_unavailable" };
      }
    }
    const oldAlias = this.aliasInternal;
    const oldSocket = this.socket;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 1. detach the old alias (no reconnect loop — intentionallyClosed)
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.pending.cancelAll("renamed");
    this.socket = null;
    this.online = false;
    if (oldSocket && !oldSocket.destroyed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ACK_TIMEOUT_MS);
        t.unref();
        oldSocket.once("close", () => {
          clearTimeout(t);
          resolve();
        });
        oldSocket.end();
      });
    }

    // 2. re-hello under the new alias. NO alias_fallback here: rename()
    //    handles alias_taken itself (restore the previous identity below).
    this.aliasInternal = target;
    this.intentionallyClosed = false;
    try {
      await this.doConnect();
    } catch (err) {
      // restore the previous identity so the session stays usable
      this.aliasInternal = oldAlias;
      this.intentionallyClosed = true;
      try {
        await this.connect();
      } catch {
        // broker down entirely — nothing more we can do
      }
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: detail.includes("alias_taken") ? "alias_taken" : detail };
    }
    this.emit("renamed", { from: oldAlias, to: target });
    return { ok: true, alias: target };
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
