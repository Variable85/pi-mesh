// test/reply-hints.test.ts — M2 compact context: the full mesh_reply
// instruction shows on first sight per sender, after long silences, and
// periodically (1/20) so it survives /compact — while ordinary messages
// carry only the short (m_id) suffix.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReplyHintTracker } from "../src/extension/reply-hints.js";

describe("ReplyHintTracker", () => {
  it("first sight from a sender shows the hint", () => {
    const t = new ReplyHintTracker(() => 1_000);
    assert.equal(t.shouldShow("alice"), true);
  });

  it("subsequent messages from the same sender within the window do not", () => {
    const t = new ReplyHintTracker(() => 1_000);
    t.shouldShow("alice");
    assert.equal(t.shouldShow("alice"), false);
    assert.equal(t.shouldShow("alice"), false);
  });

  it("long silence (≥ 30 min) re-shows the hint", () => {
    let now = 1_000;
    const t = new ReplyHintTracker(() => now);
    t.shouldShow("alice"); // taught
    now += 29 * 60_000;
    assert.equal(t.shouldShow("alice"), false); // 29 min — still fresh
    now += 2 * 60_000; // 31 min total
    assert.equal(t.shouldShow("alice"), true); // silence elapsed
    assert.equal(t.shouldShow("alice"), false); // re-taught
  });

  it("periodic refresh: every 20th message shows the hint again", () => {
    const t = new ReplyHintTracker(() => 1_000); // frozen clock — no silence
    assert.equal(t.shouldShow("bob"), true); // #1
    let shown = 0;
    for (let i = 2; i <= 40; i += 1) {
      if (t.shouldShow("bob")) shown += 1;
    }
    assert.equal(shown, 2, "messages #20 and #40 re-teach (19 in between do not)");
  });

  it("unknown sender falls back to showing the hint (safe default)", () => {
    const t = new ReplyHintTracker(() => 1_000);
    assert.equal(t.shouldShow(undefined), true);
    assert.equal(t.shouldShow(""), true);
  });

  it("reset() forgets everyone (post-compaction re-teach)", () => {
    const t = new ReplyHintTracker(() => 1_000);
    t.shouldShow("alice");
    t.reset();
    assert.equal(t.shouldShow("alice"), true);
  });

  it("bounded tracker: cap clears state instead of growing forever", () => {
    const t = new ReplyHintTracker(() => 1_000, 30 * 60_000, 20, 4);
    t.shouldShow("a"); t.shouldShow("b"); t.shouldShow("c"); t.shouldShow("d");
    assert.equal(t.size, 4);
    t.shouldShow("e"); // 5th distinct sender — insert hits the cap and clears
    assert.equal(t.shouldShow("a"), true, "state was cleared — a is 'new' again");
  });
});
