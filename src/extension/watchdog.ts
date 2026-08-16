// extension/watchdog.ts — one-turn context watchdog. Detects degenerate
// generations (a single assistant message with hundreds of duplicate tool
// calls — all rejected, but their error results still grow the session file
// by megabytes and slow every later turn) and notifies the USER immediately
// instead of leaving the discovery to /compact hours later.
// Pure analysis only: no I/O, no Pi imports — fully unit-testable.
//
// Real-world calibration (measured incident): one turn = 3450 tool calls,
// 3450 rejected results, +7.9 MB file growth, context 70k → 206k tokens,
// median turn latency 12 s → 118 s. A healthy session: ≤10 calls per
// message, <0.5 MB per turn.

/** Inputs gathered by the caller at turn_end (all best-effort). */
export interface TurnSample {
  /** Session-file size in bytes after the turn; null when unavailable. */
  fileBytes: number | null;
  /** Tool calls in the assistant message of this turn. */
  toolCalls: number;
  /** Tool results rejected by the host ("was not executed" …). */
  rejectedCalls: number;
  /** Epoch ms. */
  at: number;
}

export interface WatchdogThresholds {
  /** One-turn file growth above this → spike. */
  spikeBytes: number;
  /** More tool calls than this in ONE message → burst. */
  maxCalls: number;
  /** File-size drop beyond this → compaction detected. */
  compactionBytes: number;
}

export type WatchdogVerdict =
  | { type: "ok" }
  | {
      type: "burst";
      toolCalls: number;
      rejectedCalls: number;
      deltaBytes: number | null;
    }
  | { type: "spike"; deltaBytes: number }
  | { type: "compaction"; deltaBytes: number };

/** Count toolCall blocks in a Pi assistant message (content array). */
export function countToolCalls(message: unknown): number {
  if (message === null || typeof message !== "object") return 0;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "toolCall"
    ) {
      n += 1;
    }
  }
  return n;
}

/** Count rejected tool results ("was not executed … token limit …"). */
export function countRejected(toolResults: readonly unknown[]): number {
  let n = 0;
  for (const tr of toolResults) {
    const text = JSON.stringify(tr ?? "");
    if (text.includes("was not executed")) n += 1;
  }
  return n;
}

/**
 * Classify the turn against the previous sample.
 * - compaction wins over everything (a file drop is never a burst);
 * - burst is count-based (works even without file stats);
 * - spike is size-based (a huge-but-legal output);
 * - the FIRST sample has no baseline → ok.
 */
export function analyzeTurn(
  now: TurnSample,
  prev: TurnSample | null,
  cfg: WatchdogThresholds,
): WatchdogVerdict {
  if (prev === null) return { type: "ok" };
  const deltaBytes =
    now.fileBytes !== null && prev.fileBytes !== null
      ? now.fileBytes - prev.fileBytes
      : null;
  if (deltaBytes !== null && deltaBytes <= -cfg.compactionBytes) {
    return { type: "compaction", deltaBytes };
  }
  if (now.toolCalls > cfg.maxCalls) {
    return {
      type: "burst",
      toolCalls: now.toolCalls,
      rejectedCalls: now.rejectedCalls,
      deltaBytes,
    };
  }
  if (deltaBytes !== null && deltaBytes >= cfg.spikeBytes) {
    return { type: "spike", deltaBytes };
  }
  return { type: "ok" };
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** Human line for ctx.ui.notify (also shown in tests). */
export function renderVerdict(v: WatchdogVerdict): string {
  switch (v.type) {
    case "burst": {
      const size =
        v.deltaBytes !== null && v.deltaBytes > 0
          ? `, session file +${mb(v.deltaBytes)}`
          : "";
      return (
        `mesh watchdog ⚠ degenerate turn: ${v.toolCalls} tool calls in ONE message ` +
        `(${v.rejectedCalls} rejected${size}) — context damaged, /compact recommended`
      );
    }
    case "spike":
      return (
        `mesh watchdog ⚠ session file +${mb(v.deltaBytes)} in one turn — ` +
        `check the last tool output; /compact if it was junk`
      );
    case "compaction":
      return `mesh watchdog: session compacted (−${mb(-v.deltaBytes)}) — mesh context resynced`;
    case "ok":
      return "";
  }
}
