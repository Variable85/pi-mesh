// extension/ledger.ts — hash-only append-only ledger <stateDir>/ledger.jsonl (§9.5).
// I1 body-free durable: never a message body, only hashes + metadata.
// C5 fix: callers write `delivered` ONLY after the broker ack (enforced by wiring).
// E25: recursive forbidden-key scan before EVERY append → throw fail-closed.
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { hasForbiddenPersistedKey } from "../protocol/envelope.js";
import { nowIso } from "../protocol/frames.js";
import { DEFAULT_LEDGER_MAX_BYTES } from "../shared/config.js";
import { LEDGER_FILE_NAME } from "../shared/paths.js";

export const LEDGER_SCHEMA = "mesh.ledger.v1";

export type LedgerEventName =
  | "sent"
  | "delivered"
  | "queued_offline"
  | "reply"
  | "expired"
  | "blocked"
  | "error"
  | "inbound"
  | "reserved"
  | "released";

export interface LedgerRecord {
  schema: typeof LEDGER_SCHEMA;
  event: LedgerEventName;
  id?: string;
  from?: string;
  to?: string;
  room?: string;
  priority?: string;
  bodyHash?: string;
  reasonHash?: string;
  refs?: string[];
  code?: string;
  ts: string;
  bodyStored: false;
}

/** Fields the caller supplies; schema/ts/bodyStored are stamped by the ledger. */
export type LedgerInput = Omit<LedgerRecord, "schema" | "ts" | "bodyStored">;

export class MeshLedger {
  constructor(
    readonly stateDir: string,
    private readonly maxBytes: number = DEFAULT_LEDGER_MAX_BYTES,
  ) {}

  get path(): string {
    return path.join(this.stateDir, LEDGER_FILE_NAME);
  }

  /**
   * Append one record. Fail-closed (E25): recursive scan of forbidden persisted
   * keys BEFORE writing — a violation throws and zero bytes are appended (I1).
   */
  append(input: LedgerInput): LedgerRecord {
    const record: LedgerRecord = {
      schema: LEDGER_SCHEMA,
      ...input,
      ts: nowIso(),
      bodyStored: false,
    };
    if (hasForbiddenPersistedKey(record)) {
      throw new Error("mesh ledger fail-closed: forbidden persisted key (E25)");
    }
    mkdirSync(this.stateDir, { recursive: true });
    this.rotateIfNeeded();
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  /** Simple rotation: when ledger.jsonl exceeds maxBytes → ledger-<date>.jsonl.1 (§9.5). */
  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return; // no file yet
    }
    if (size <= this.maxBytes) return;
    const date = new Date().toISOString().slice(0, 10);
    // ledger-<date>.jsonl.N — N increments so repeated rotations never overwrite
    let n = 1;
    while (existsSync(path.join(this.stateDir, `ledger-${date}.jsonl.${n}`))) n += 1;
    renameSync(this.path, path.join(this.stateDir, `ledger-${date}.jsonl.${n}`));
  }
}
