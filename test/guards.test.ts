// test/guards.test.ts — §9.4: self-send, duplicate 10 s window, client caps
// (30/5/1 per min), loopGuard warn-only, observer readonly.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DUPLICATE_WINDOW_MS,
  LOOP_GUARD_WARNING,
  MeshGuards,
} from "../src/extension/guards.js";

function makeGuards(nowRef: { now: number }): MeshGuards {
  return new MeshGuards({ msgPerMin: 30, urgentPerMin: 5, forcePerMin: 1 }, () => nowRef.now);
}

const base = { from: "alice", to: "bob", room: "default", body: "hello", priority: "normal" as const };

describe("guards: blocking rules", () => {
  it("self-send → blocked (case/@-insensitive)", () => {
    const ref = { now: 1000 };
    const g = makeGuards(ref);
    const r = g.checkSend({ ...base, from: "alice", to: "@Alice" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "self_send");
  });

  it("duplicate (to, room, bodyHash) within 10 s → blocked; after window → ok", () => {
    const ref = { now: 10_000 };
    const g = makeGuards(ref);
    assert.equal(g.checkSend(base).ok, true);
    const dup = g.checkSend(base); // same tuple, same instant
    assert.equal(dup.ok, false);
    if (!dup.ok) assert.equal(dup.reason, "duplicate_in_window");
    ref.now += DUPLICATE_WINDOW_MS; // exactly at the boundary → allowed again
    assert.equal(g.checkSend(base).ok, true);
  });

  it("same body to a DIFFERENT target is not a duplicate", () => {
    const ref = { now: 10_000 };
    const g = makeGuards(ref);
    assert.equal(g.checkSend(base).ok, true);
    assert.equal(g.checkSend({ ...base, to: "carol" }).ok, true);
  });

  it("client cap: 30 msg/min pass, 31st blocked", () => {
    const ref = { now: 10_000 };
    const g = makeGuards(ref);
    for (let i = 0; i < 30; i += 1) {
      const r = g.checkSend({ ...base, body: `m${i}` });
      assert.equal(r.ok, true, `msg ${i}`);
    }
    const r = g.checkSend({ ...base, body: "m30" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "rate_limited:msg");
    ref.now += 60_000; // next minute window
    assert.equal(g.checkSend({ ...base, body: "m31" }).ok, true);
  });

  it("client cap: 5 urgent/min pass, 6th blocked", () => {
    const ref = { now: 10_000 };
    const g = makeGuards(ref);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(g.checkSend({ ...base, body: `u${i}`, priority: "urgent" }).ok, true);
    }
    const r = g.checkSend({ ...base, body: "u5", priority: "urgent" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "rate_limited:urgent");
  });

  it("client cap: 1 force/min passes, 2nd blocked", () => {
    const ref = { now: 10_000 };
    const g = makeGuards(ref);
    assert.equal(g.checkSend({ ...base, body: "f0", priority: "force" }).ok, true);
    const r = g.checkSend({ ...base, body: "f1", priority: "force" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "rate_limited:force");
  });

  it("observer role → observer_readonly", () => {
    const ref = { now: 10_000 };
    const g = makeGuards(ref);
    const r = g.checkSend({ ...base, role: "observer" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "observer_readonly");
  });
});

describe("guards: loopGuard is warn-only (NEVER blocks)", () => {
  it("body containing mesh_send( → ok + warning", () => {
    const ref = { now: 10_000 };
    const g = makeGuards(ref);
    const r = g.checkSend({ ...base, body: "please call mesh_send({to:'bob'}) now" });
    assert.equal(r.ok, true); // not blocked
    if (r.ok) assert.ok(r.warnings.includes(LOOP_GUARD_WARNING));
  });

  it("clean body → no warnings", () => {
    const ref = { now: 10_000 };
    const g = makeGuards(ref);
    const r = g.checkSend(base);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.warnings, []);
  });
});
