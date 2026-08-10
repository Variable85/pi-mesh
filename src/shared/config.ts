// shared/config.ts — ALL named numeric bounds (I8) + config.json/env loading (§12).
// Every bound in the system is a named constant here or derived from MeshConfig.
import { readFileSync } from "node:fs";
import { configPath } from "./paths.js";

// ---- Framing (D17, §6.1) ----
export const DEFAULT_MAX_FRAME_BYTES = 65_536; // 64 KiB
export const HARD_MIN_FRAME_BYTES = 1_024;
export const HARD_MAX_FRAME_BYTES = 1_048_576; // 1 MiB
export const MAX_BODY_BYTES = 32_768; // 32 KiB (§6.2 rule 4)
export const MAX_FRAME_ID_CHARS = 64;
export const MAX_REFS = 8;
export const MAX_REF_CHARS = 256;

// ---- Timeouts (§6.1) ----
export const HELLO_TIMEOUT_MS = 5_000;
export const WRITE_TIMEOUT_MS = 5_000;
export const DEFAULT_HEARTBEAT_MS = 15_000; // client ping (D16)
export const DEFAULT_BROKER_SILENCE_MS = 45_000; // broker cutoff (D16)
export const SWEEP_INTERVAL_MS = 15_000; // broker silence sweep (§7.6)
export const STATUS_REQ_TIMEOUT_MS = 5_000;
export const ACK_TIMEOUT_MS = 5_000;

// ---- Mailbox (D9, §7.7) ----
export const DEFAULT_MAILBOX_CAP = 100;
export const DEFAULT_MAILBOX_TTL_MS = 3_600_000; // 1 h
export const MAILBOX_PURGE_INTERVAL_MS = 60_000;

// ---- Rooms (§6.5) ----
export const DEFAULT_MAX_ROOMS_PER_PEER = 16;
export const MAX_PEERS_PER_ROOM = 64;
export const DEFAULT_ROOM = "default";

// ---- Rate limits (§6.6, §12 policy.rateLimits) ----
export const DEFAULT_RATE_MSG_PER_MIN = 30;
export const DEFAULT_RATE_URGENT_PER_MIN = 5;
export const DEFAULT_RATE_FORCE_PER_MIN = 1;
export const RATE_BUCKET_WINDOW_MS = 60_000;

// ---- Reconnect / outbox (§8) ----
export const RECONNECT_BASE_MS = 250;
export const RECONNECT_MAX_MS = 5_000;
export const OUTBOX_FLUSH_CAP = 50;

// ---- awaitReply (§8) ----
export const DEFAULT_AWAIT_REPLY_TIMEOUT_MS = 1_800_000; // 30 min — missions run long;
// a short default (was 10 min) made orchestration "expire" while agents were
// still working, which triggered re-sends and duplicate replies.
export const MIN_AWAIT_REPLY_TIMEOUT_MS = 25;
export const MAX_AWAIT_REPLY_TIMEOUT_MS = 1_800_000; // 30 min
export const MAX_REMINDS = 2; // D8

// ---- ensureBroker (§7.4) ----
export const ENSURE_BROKER_POLL_MS = 50;
export const ENSURE_BROKER_MAX_POLLS = 60; // 3 s
export const LOCK_RETRY_MAX = 3;

// ---- Identity defaults (§6.4) ----
export const ALIAS_RAND_CHARS = 6;
export const MSG_ID_RAND_CHARS = 8;
export const ALIAS_REGEX = /^[a-z][a-z0-9-]{1,31}$/;
export const ROOM_REGEX = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

// ---- Transcript / ledger (§9.5/§9.6 — bounds shared, files are Wave B) ----
export const TRANSCRIPT_RING_SIZE = 200;
export const DEFAULT_LEDGER_MAX_BYTES = 5_242_880; // 5 MiB
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 7;

export interface MeshConfig {
  alias?: string;
  rooms: string[];
  maxFrameBytes: number;
  heartbeatMs: number;
  brokerSilenceMs: number;
  mailboxCap: number;
  mailboxTtlMs: number;
  maxRoomsPerPeer: number;
  transcript: boolean;
  transcriptRetentionDays: number;
  ledgerMaxBytes: number;
}

export const DEFAULT_CONFIG: MeshConfig = {
  rooms: [DEFAULT_ROOM],
  maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
  heartbeatMs: DEFAULT_HEARTBEAT_MS,
  brokerSilenceMs: DEFAULT_BROKER_SILENCE_MS,
  mailboxCap: DEFAULT_MAILBOX_CAP,
  mailboxTtlMs: DEFAULT_MAILBOX_TTL_MS,
  maxRoomsPerPeer: DEFAULT_MAX_ROOMS_PER_PEER,
  transcript: false,
  transcriptRetentionDays: DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  ledgerMaxBytes: DEFAULT_LEDGER_MAX_BYTES,
};

function clampFrameBytes(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_FRAME_BYTES;
  return Math.min(HARD_MAX_FRAME_BYTES, Math.max(HARD_MIN_FRAME_BYTES, Math.floor(n)));
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function envInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Load config: defaults < <stateDir>/config.json < env (§12).
 * Env overrides: MESH_ALIAS, MESH_ROOMS (csv), MESH_MAX_FRAME_BYTES,
 * MESH_MAILBOX_CAP, MESH_MAILBOX_TTL_MS, MESH_TRANSCRIPT.
 */
export function loadConfig(stateDir?: string, env: NodeJS.ProcessEnv = process.env): MeshConfig {
  let fileCfg: Partial<MeshConfig> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(stateDir, env), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      fileCfg = parsed as Partial<MeshConfig>;
    }
  } catch {
    // missing/invalid config.json → defaults (graceful, I10)
  }

  const cfg: MeshConfig = {
    ...DEFAULT_CONFIG,
    rooms:
      Array.isArray(fileCfg.rooms) && fileCfg.rooms.every((r) => typeof r === "string")
        ? [...fileCfg.rooms]
        : [...DEFAULT_CONFIG.rooms],
    maxFrameBytes: clampFrameBytes(positiveInt(fileCfg.maxFrameBytes, DEFAULT_CONFIG.maxFrameBytes)),
    heartbeatMs: positiveInt(fileCfg.heartbeatMs, DEFAULT_CONFIG.heartbeatMs),
    brokerSilenceMs: positiveInt(fileCfg.brokerSilenceMs, DEFAULT_CONFIG.brokerSilenceMs),
    mailboxCap: positiveInt(fileCfg.mailboxCap, DEFAULT_CONFIG.mailboxCap),
    mailboxTtlMs: positiveInt(fileCfg.mailboxTtlMs, DEFAULT_CONFIG.mailboxTtlMs),
    maxRoomsPerPeer: positiveInt(fileCfg.maxRoomsPerPeer, DEFAULT_CONFIG.maxRoomsPerPeer),
    transcript: fileCfg.transcript === true,
    transcriptRetentionDays: positiveInt(
      fileCfg.transcriptRetentionDays,
      DEFAULT_CONFIG.transcriptRetentionDays,
    ),
    ledgerMaxBytes: positiveInt(fileCfg.ledgerMaxBytes, DEFAULT_CONFIG.ledgerMaxBytes),
  };
  if (typeof fileCfg.alias === "string" && fileCfg.alias.trim() !== "") cfg.alias = fileCfg.alias;

  // env overrides (priority over config file)
  const envAlias = env.MESH_ALIAS;
  if (envAlias && envAlias.trim() !== "") cfg.alias = envAlias;
  const envRooms = env.MESH_ROOMS;
  if (envRooms && envRooms.trim() !== "") {
    cfg.rooms = envRooms
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  const envFrame = envInt(env, "MESH_MAX_FRAME_BYTES");
  if (envFrame !== undefined) cfg.maxFrameBytes = clampFrameBytes(envFrame);
  const envCap = envInt(env, "MESH_MAILBOX_CAP");
  if (envCap !== undefined) cfg.mailboxCap = envCap;
  const envTtl = envInt(env, "MESH_MAILBOX_TTL_MS");
  if (envTtl !== undefined) cfg.mailboxTtlMs = envTtl;
  const envTranscript = env.MESH_TRANSCRIPT;
  if (envTranscript !== undefined) cfg.transcript = envTranscript === "1" || envTranscript === "true";

  return cfg;
}
