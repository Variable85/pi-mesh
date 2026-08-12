// broker/mailbox.ts — offline queue per alias: cap, TTL, flush.
import type { MeshFrame } from "../protocol/envelope.js";
import type { MeshConfig } from "../shared/config.js";
import type { BrokerState, StoredMsg } from "./state.js";

function dropExpired(
  state: BrokerState,
  alias: string,
  ttlMs: number,
  now: number,
): StoredMsg[] {
  const queue = state.mailbox.get(alias) ?? [];
  const fresh = queue.filter((m) => now - m.enqueuedAt <= ttlMs);
  const dropped = queue.length - fresh.length;
  if (dropped > 0) state.stats.mailboxDropped += dropped;
  if (fresh.length === 0) state.mailbox.delete(alias);
  else state.mailbox.set(alias, fresh);
  return fresh;
}

/** Enqueue for a known offline alias. At cap, the oldest is dropped. */
export function enqueueMailbox(
  state: BrokerState,
  config: MeshConfig,
  alias: string,
  frame: MeshFrame,
  now: number = Date.now(),
): void {
  const queue = dropExpired(state, alias, config.mailboxTtlMs, now);
  queue.push({ frame, enqueuedAt: now });
  while (queue.length > config.mailboxCap) {
    queue.shift();
    state.stats.mailboxDropped += 1;
  }
  state.mailbox.set(alias, queue);
}

/** Periodic TTL purge across all aliases. */
export function purgeAllExpired(
  state: BrokerState,
  config: MeshConfig,
  now: number = Date.now(),
): void {
  for (const alias of [...state.mailbox.keys()]) {
    dropExpired(state, alias, config.mailboxTtlMs, now);
  }
}

export function mailboxSize(state: BrokerState, config: MeshConfig, alias: string): number {
  return dropExpired(state, alias, config.mailboxTtlMs, Date.now()).length;
}

/**
 * Drain the mailbox at hello: returns stored frames (as `mailbox` frames with
 * queuedAt) in enqueue order and clears the queue.
 */
export function flushMailbox(
  state: BrokerState,
  config: MeshConfig,
  alias: string,
  now: number = Date.now(),
): MeshFrame[] {
  const queue = dropExpired(state, alias, config.mailboxTtlMs, now);
  state.mailbox.delete(alias);
  state.stats.mailboxDelivered += queue.length;
  return queue.map((stored) => ({
    ...stored.frame,
    type: "mailbox",
    queuedAt: new Date(stored.enqueuedAt).toISOString(),
  }));
}
