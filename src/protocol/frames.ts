// protocol/frames.ts — NDJSON framing (D17), sha256, ids, clock. No Pi imports (I9).
import { createHash, randomBytes } from "node:crypto";
import { MSG_ID_RAND_CHARS } from "../shared/config.js";

export class FrameSizeError extends Error {
  override readonly name = "FrameSizeError";
  constructor(message: string) {
    super(message);
  }
}

export function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** m_<time36>_<rand8hex> (D18). */
export function makeMsgId(rand: (size: number) => Buffer = randomBytes): string {
  const time36 = Date.now().toString(36);
  const randHex = rand(MSG_ID_RAND_CHARS / 2).toString("hex").slice(0, MSG_ID_RAND_CHARS);
  return `m_${time36}_${randHex}`;
}

/** Encode one frame as a NDJSON line. Throws FrameSizeError over maxBytes. */
export function encodeFrame(value: unknown, maxBytes: number): Buffer {
  const line = JSON.stringify(value) + "\n";
  const buf = Buffer.from(line, "utf8");
  if (buf.byteLength > maxBytes) {
    throw new FrameSizeError(`frame ${buf.byteLength}B exceeds max ${maxBytes}B`);
  }
  return buf;
}

/**
 * Incremental NDJSON decoder with chunk reassembly.
 * Throws FrameSizeError when a single line (or the partial buffer) exceeds maxBytes.
 */
export class FrameDecoder {
  private buf = "";
  private bufBytes = 0;

  constructor(private readonly maxBytes: number) {}

  /** Feed a chunk; returns complete lines (without trailing \n). */
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.buf += text;
    this.bufBytes = Buffer.byteLength(this.buf, "utf8");
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx);
      const rest = this.buf.slice(idx + 1);
      this.buf = rest;
      this.bufBytes = Buffer.byteLength(rest, "utf8");
      if (Buffer.byteLength(line, "utf8") > this.maxBytes) {
        throw new FrameSizeError(`frame line exceeds max ${this.maxBytes}B`);
      }
      if (line.length > 0) lines.push(line);
    }
    if (this.bufBytes > this.maxBytes) {
      throw new FrameSizeError(`partial frame exceeds max ${this.maxBytes}B`);
    }
    return lines;
  }
}
