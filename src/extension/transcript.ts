// extension/transcript.ts — OPT-IN transcript with redaction (§9.6, D13).
// Off by default; on via config.transcript, MESH_TRANSCRIPT=1, or setEnabled
// (/mesh log on|off). Bodies are stored ONLY here, after redaction + 32 KiB
// UTF-8-safe truncation. The ledger stays hash-only even when enabled (I1).
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { MeshFrame } from "../protocol/envelope.js";
import { nowIso } from "../protocol/frames.js";
import { DEFAULT_TRANSCRIPT_RETENTION_DAYS } from "../shared/config.js";

export const TRANSCRIPT_MAX_BODY_BYTES = 32 * 1024; // 32 KiB
export const TRUNCATED_MARKER = "…[truncated]";
const DAY_MS = 86_400_000;

export interface SecretPattern {
  name: string;
  re: RegExp;
  replacement: string;
}

/** Redaction profile (§9.6 — adapted from the harness transcript-capture module). */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "private_key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:PRIVATE_KEY]",
  },
  {
    name: "bearer_token",
    re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: "[REDACTED:BEARER]",
  },
  {
    name: "api_key",
    re: /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g,
    replacement: "[REDACTED:API_KEY]",
  },
  {
    name: "aws_access_key",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:AWS_ACCESS_KEY]",
  },
  {
    name: "secret_assignment",
    re: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*[^\s"']+/g,
    replacement: "[REDACTED:SECRET_ASSIGNMENT]",
  },
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED:EMAIL]",
  },
];

/** Apply every secret pattern. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p.re, p.replacement);
  return out;
}

/** Truncate to ≤ maxBytes UTF-8 bytes WITHOUT splitting a codepoint. */
export function truncateUtf8(text: string, maxBytes: number = TRANSCRIPT_MAX_BODY_BYTES): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // back off UTF-8 continuation bytes (10xxxxxx) so we never split a codepoint
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8") + TRUNCATED_MARKER;
}

export interface TranscriptEntry {
  ts: string;
  dir: "in" | "out";
  frame: MeshFrame; // body redacted + truncated
}

export class MeshTranscript {
  private enabled: boolean;

  constructor(
    private readonly stateDir: string,
    enabled: boolean,
    private readonly retentionDays: number = DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  ) {
    this.enabled = enabled;
    if (enabled) this.pruneRetention();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** /mesh log on|off. Enabling triggers a retention pass. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.pruneRetention();
  }

  private transcriptsDir(): string {
    return path.join(this.stateDir, "transcripts");
  }

  private filePath(date: Date = new Date()): string {
    return path.join(this.transcriptsDir(), `${date.toISOString().slice(0, 10)}.jsonl`);
  }

  /** Record one frame; body is redacted + truncated. No-op when disabled. */
  record(dir: "in" | "out", frame: MeshFrame): void {
    if (!this.enabled) return;
    const clean: MeshFrame = { ...frame };
    if (typeof clean.body === "string") {
      clean.body = truncateUtf8(redactSecrets(clean.body));
    }
    const entry: TranscriptEntry = { ts: nowIso(), dir, frame: clean };
    mkdirSync(this.transcriptsDir(), { recursive: true });
    appendFileSync(this.filePath(), JSON.stringify(entry) + "\n", "utf8");
  }

  /** Delete transcript day-files older than retentionDays (§9.6). Returns count removed. */
  pruneRetention(now: number = Date.now()): number {
    let names: string[];
    try {
      names = readdirSync(this.transcriptsDir());
    } catch {
      return 0;
    }
    const maxAgeMs = this.retentionDays * DAY_MS;
    let removed = 0;
    for (const name of names) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const day = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`);
      if (Number.isNaN(day)) continue;
      if (now - day > maxAgeMs) {
        try {
          unlinkSync(path.join(this.transcriptsDir(), name));
          removed += 1;
        } catch {
          // best effort
        }
      }
    }
    return removed;
  }
}
