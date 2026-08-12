// test/status-summary.test.ts — Phase 3: buildStatusSummary (likely-done
// inference from announced activity + missions).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStatusSummary } from "../src/extension/tools.js";

const now = Date.now();
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();

describe("buildStatusSummary (Phase 3)", () => {
  it("announced busy → working; idle without pending missions → likely done", () => {
    const peers = [
      { alias: "a1", activity: { state: "busy" as const, at: iso(1000) } },
      { alias: "a2", activity: { state: "idle" as const, at: iso(60_000) } },
      { alias: "a3", activity: { state: "idle" as const, at: iso(120_000) } },
    ];
    const missions = [{ to: "a3", status: "waiting" }]; // a3 still owes an answer
    const s = buildStatusSummary(peers, missions, 120_000, 900_000, now);
    assert.equal(s.working, 1);
    assert.equal(s.idle, 2);
    assert.equal(s.likelyDone, 1); // a2 only (a3 has a waiting mission)
    assert.equal(s.stuck, 0);
  });

  it("heuristic fallback for peers that never announce (old versions)", () => {
    const peers = [
      { alias: "old1", lastSeenAt: iso(10_000) }, // recent → working
      { alias: "old2", lastSeenAt: iso(1_800_000), reservations: [{ pattern: "web/" }] }, // idle 30min + holds → stuck
      { alias: "old3", lastSeenAt: iso(600_000) }, // idle, no missions → likely done
    ];
    const s = buildStatusSummary(peers, [], 120_000, 900_000, now);
    assert.equal(s.working, 1);
    assert.equal(s.stuck, 1);
    assert.equal(s.idle, 1);
    assert.equal(s.likelyDone, 1);
  });

  it("rate_limited and blocked peers are counted separately", () => {
    const peers = [
      { alias: "a1", activity: { state: "rate_limited" as const, at: iso(1000) } },
      { alias: "a2", activity: { state: "blocked" as const, at: iso(1000) } },
      { alias: "a3", activity: { state: "idle" as const, at: iso(1000) } },
    ];
    const s = buildStatusSummary(peers, [], 120_000, 900_000, now);
    assert.equal(s.rateLimited, 1);
    assert.equal(s.blocked, 1);
    assert.equal(s.idle, 1);
    assert.equal(s.likelyDone, 1); // a3 only — failure states are not "done"
  });

  it("announced idle wins over the heuristic (no flicker for old peers)", () => {
    const peers = [
      { alias: "x", activity: { state: "idle" as const, at: iso(30_000) }, lastSeenAt: iso(5_000) },
    ];
    const s = buildStatusSummary(peers, [], 120_000, 900_000, now);
    assert.equal(s.working, 0);
    assert.equal(s.idle, 1);
  });
});
