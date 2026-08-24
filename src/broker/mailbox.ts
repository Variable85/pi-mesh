// broker/mailbox.ts — offline queue per alias: cap, TTL, flush.
// Every function that drops entries RETURNS them so the broker can send
// honest drop notices to the original senders — a message that leaves the
// mailbox without being delivered must never vanish silently.
import type { MeshFrame } from "../protocol/envelope.js";
import type { MeshConfig } from "../shared/config.js";
import type { BrokerState, StoredMsg } from "./state.js";

/** Split one alias queue at the TTL boundary (mutates state.mailbox). */
function partitionExpired(
  state: BrokerState,
  alias: string,
  ttlMs: number,
  now: number,
): { fresh: StoredMsg[]; dropped: StoredMsg[] } {
  const queue = state.mailbox.get(alias) ?? [];
  const fresh: StoredMsg[] = [];
  const dropped: StoredMsg[] = [];
  for (const m of queue) {
    if (now - m.enqueuedAt <= ttlMs) fresh.push(m);
    else dropped.push(m);
  }
  if (dropped.length > 0) state.stats.mailboxDropped += dropped.length;
  if (fresh.length === 0) state.mailbox.delete(alias);
  else state.mailbox.set(alias, fresh);
  return { fresh, dropped };
}

/**
 * Enqueue for a known offline alias. At cap, the oldest is dropped.
 * Returns every entry dropped by TTL or cap so the caller can notify
 * the senders.
 */
export function enqueueMailbox(
  state: BrokerState,
  config: MeshConfig,
  alias: string,
  frame: MeshFrame,
  now: number = Date.now(),
): StoredMsg[] {
  const { fresh, dropped } = partitionExpired(state, alias, config.mailboxTtlMs, now);
  fresh.push({ frame, enqueuedAt: now });
  while (fresh.length > config.mailboxCap) {
    const evicted = fresh.shift();
    if (evicted === undefined) break;
    dropped.push(evicted);
    state.stats.mailboxDropped += 1;
  }
  state.mailbox.set(alias, fresh);
  return dropped;
}

/** Periodic TTL purge across all aliases. Returns everything dropped. */
export function purgeAllExpired(
  state: BrokerState,
  config: MeshConfig,
  now: number = Date.now(),
): StoredMsg[] {
  const dropped: StoredMsg[] = [];
  for (const alias of [...state.mailbox.keys()]) {
    dropped.push(...partitionExpired(state, alias, config.mailboxTtlMs, now).dropped);
  }
  return dropped;
}

export function mailboxSize(state: BrokerState, config: MeshConfig, alias: string): number {
  return partitionExpired(state, alias, config.mailboxTtlMs, Date.now()).fresh.length;
}

/**
 * Drain the mailbox at hello: returns stored frames (as `mailbox` frames with
 * queuedAt) in enqueue order, clears the queue, and surfaces any entries
 * that expired while the owner was away (for drop notices).
 */
export function flushMailbox(
  state: BrokerState,
  config: MeshConfig,
  alias: string,
  now: number = Date.now(),
): { frames: MeshFrame[]; dropped: StoredMsg[] } {
  const { fresh, dropped } = partitionExpired(state, alias, config.mailboxTtlMs, now);
  state.mailbox.delete(alias);
  state.stats.mailboxDelivered += fresh.length;
  return {
    frames: fresh.map((stored) => ({
      ...stored.frame,
      type: "mailbox",
      queuedAt: new Date(stored.enqueuedAt).toISOString(),
    })),
    dropped,
  };
}
