// extension/identity.ts — mesh identity persistence (D23).
//
// Problem: /reload (and pi extension reloads in general) fire
// session_shutdown + session_start: the old MeshClient is closed (the broker
// purges alias, rooms and reservations with the connection) and a NEW client
// is created — with a NEW random alias. The agent "loses" its mesh identity
// on every reload.
//
// Fix: persist the identity per pi-sessionId in <stateDir>/identity.json.
// The pi sessionId is stable across reloads (the session manager survives),
// so a reload re-loads the exact same alias, rooms and reservations.
// A different sessionId (new session, fork) gets a fresh identity.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nowIso } from "../protocol/frames.js";
import { isValidReservations, type FileReservation } from "../protocol/envelope.js";

export const IDENTITY_FILE_NAME = "identity.json";
export const IDENTITY_VERSION = 1;
/** Persisted reservations older than this are NOT re-declared at hello. */
export const RESERVATION_TTL_MS = 86_400_000; // 24 h

export interface PersistedIdentity {
  version: typeof IDENTITY_VERSION;
  sessionId: string;
  alias: string;
  rooms: string[];
  reservations: FileReservation[];
  updatedAt: string;
}

/** Snapshot the current client state into a persistable identity. */
export function identityFromClient(
  sessionId: string,
  client: {
    alias: string;
    rooms: readonly string[];
    reservations: readonly FileReservation[];
  },
): PersistedIdentity {
  return {
    version: IDENTITY_VERSION,
    sessionId,
    alias: client.alias,
    rooms: [...client.rooms],
    reservations: client.reservations.map((r) => ({ ...r })),
    updatedAt: nowIso(),
  };
}

/** Drop reservations whose `since` is older than the TTL (stale claims). */
function freshReservations(list: FileReservation[], now: number = Date.now()): FileReservation[] {
  return list.filter((r) => {
    if (r.since === undefined) return true; // unknown age → keep (best effort)
    const t = Date.parse(r.since);
    if (Number.isNaN(t)) return true;
    return now - t < RESERVATION_TTL_MS;
  });
}

export class MeshIdentity {
  constructor(private readonly stateDir: string) {}

  private get path(): string {
    return path.join(this.stateDir, IDENTITY_FILE_NAME);
  }

  /**
   * Load the identity belonging to `sessionId`. Returns null when absent,
   * from another session, malformed, or on an older version — callers then
   * start fresh (random alias, default rooms, no reservations).
   */
  load(sessionId: string): PersistedIdentity | null {
    if (sessionId === "") return null;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      const id = raw as Record<string, unknown>;
      if (id.version !== IDENTITY_VERSION) return null;
      if (id.sessionId !== sessionId) return null;
      if (typeof id.alias !== "string" || id.alias === "") return null;
      const rooms = Array.isArray(id.rooms)
        ? id.rooms.filter((r): r is string => typeof r === "string")
        : [];
      const reservations = isValidReservations(id.reservations) ? freshReservations(id.reservations) : [];
      return {
        version: IDENTITY_VERSION,
        sessionId,
        alias: id.alias,
        rooms,
        reservations,
        updatedAt: typeof id.updatedAt === "string" ? id.updatedAt : nowIso(),
      };
    } catch {
      return null;
    }
  }

  /** Persist atomically (tmp + rename). Best effort — never throws (I10). */
  save(identity: PersistedIdentity): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const tmp = this.path + ".tmp";
      writeFileSync(tmp, JSON.stringify(identity, null, 2) + "\n", "utf8");
      renameSync(tmp, this.path);
    } catch {
      // best effort
    }
  }

  /** True when an identity file exists for this session (informational). */
  exists(sessionId: string): boolean {
    return this.load(sessionId) !== null;
  }
}

/** Not exported for tests: the file path is derived from the state dir. */
export function identityPath(stateDir: string): string {
  return path.join(stateDir, IDENTITY_FILE_NAME);
}

export function identityFileExists(stateDir: string): boolean {
  return existsSync(identityPath(stateDir));
}
