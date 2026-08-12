// client/pending.ts — strict replyTo===msgId correlation, reminds (≤2, expiry.
import { MAX_REMINDS } from "../shared/config.js";
import type { MeshFrame } from "../protocol/envelope.js";

export interface PendingResolution {
  kind: "reply" | "expired" | "error";
  frame?: MeshFrame;
  reason?: string;
}

interface PendingEntry {
  msgId: string;
  expiresAt: number; // ms epoch
  remindCount: number;
  timers: NodeJS.Timeout[];
  resolve: (r: PendingResolution) => void;
}

/**
 * Pending awaitReply tracker.
 * - correlation strict: replyTo === msgId (any other reply ignored + counted)
 * - reminds at T/2 and 3T/4 via onRemind hook (client sends `remind`), max 2
 * - expiry terminal at expiresAt; late reply counted, not delivered
 */
export class PendingReplies {
  private readonly entries = new Map<string, PendingEntry>();
  /** Replies with no matching live pending (orphan/late), for observability. */
  unmatchedReplyCount = 0;

  constructor(private readonly onRemind: (msgId: string) => void) {}

  register(msgId: string, expiresAtMs: number): Promise<PendingResolution> {
    this.cancel(msgId, "superseded");
    const now = Date.now();
    const total = Math.max(0, expiresAtMs - now);
    return new Promise<PendingResolution>((resolve) => {
      const entry: PendingEntry = { msgId, expiresAt: expiresAtMs, remindCount: 0, timers: [], resolve };
      const schedule = (delay: number, fn: () => void): void => {
        const t = setTimeout(fn, delay);
        t.unref();
        entry.timers.push(t);
      };
  // remind schedule: T/2 then 3T/4 (≤ MAX_REMINDS)
      const fractions = [1 / 2, 3 / 4].slice(0, MAX_REMINDS);
      for (const f of fractions) {
        const delay = total * f;
  // no instant reminds — remaining time ≤ 0 (timeout 0 or past
  // deadline) or a remind delay ≥ the expiry delay is never scheduled.
        if (delay <= 0 || delay >= total) continue;
        schedule(delay, () => {
          if (!this.entries.has(msgId)) return;
          if (entry.remindCount >= MAX_REMINDS) return;
          entry.remindCount += 1;
          this.onRemind(msgId);
        });
      }
      schedule(total, () => {
        if (this.entries.delete(msgId)) {
          entry.timers.forEach(clearTimeout);
          resolve({ kind: "expired" }); // terminal 
        }
      });
      this.entries.set(msgId, entry);
    });
  }

  /** Route an inbound reply frame. Returns true if it resolved a pending. */
  handleReply(frame: MeshFrame): boolean {
    const replyTo = frame.replyTo;
    if (replyTo === undefined) {
      this.unmatchedReplyCount += 1;
      return false;
    }
    const entry = this.entries.get(replyTo);
    if (!entry) {
      this.unmatchedReplyCount += 1; // ignored + counted
      return false;
    }
    this.entries.delete(replyTo);
    entry.timers.forEach(clearTimeout);
    entry.resolve({ kind: "reply", frame });
    return true;
  }

  has(msgId: string): boolean {
    return this.entries.has(msgId);
  }

  cancel(msgId: string, reason: string): void {
    const entry = this.entries.get(msgId);
    if (!entry) return;
    this.entries.delete(msgId);
    entry.timers.forEach(clearTimeout);
    entry.resolve({ kind: "error", reason });
  }

  /** shutdown with live pendings → all resolved error{shutting_down}. */
  cancelAll(reason: string): void {
    for (const msgId of [...this.entries.keys()]) this.cancel(msgId, reason);
  }

  get size(): number {
    return this.entries.size;
  }
}
