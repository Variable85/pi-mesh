// test/watchdog.test.ts — M1 context watchdog: pure analysis of one turn
// vs the previous sample. Replays the measured cs-agent-5 incident (3450
// duplicate tool calls, all rejected, +7.9 MB) and the healthy baseline.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeTurn,
  countRejected,
  countToolCalls,
  renderVerdict,
  type TurnSample,
} from "../src/extension/watchdog.js";

const CFG = { spikeBytes: 2_097_152, maxCalls: 64, compactionBytes: 1_048_576 };

const sample = (over: Partial<TurnSample>): TurnSample => ({
  fileBytes: 1_000_000,
  toolCalls: 3,
  rejectedCalls: 0,
  at: 1_000,
  ...over,
});

describe("watchdog counting helpers", () => {
  it("countToolCalls reads toolCall blocks from a message content array", () => {
    const msg = {
      content: [
        { type: "thinking", thinking: "x" },
        { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        { type: "text", text: "done" },
      ],
    };
    assert.equal(countToolCalls(msg), 2);
    assert.equal(countToolCalls(null), 0);
    assert.equal(countToolCalls({ content: "plain" }), 0);
  });

  it("countRejected counts 'was not executed' tool results", () => {
    const trs = [
      { content: [{ type: "text", text: "Tool call was not executed: the response hit the output token limit" }] },
      { content: [{ type: "text", text: "ok" }] },
      { content: [{ type: "text", text: "was not executed again" }] },
    ];
    assert.equal(countRejected(trs), 2);
  });
});

describe("watchdog analyzeTurn", () => {
  it("first sample has no baseline → ok", () => {
    assert.deepEqual(analyzeTurn(sample({}), null, CFG), { type: "ok" });
  });

  it("healthy turn → ok (10 calls, +0.3 MB)", () => {
    const prev = sample({});
    const now = sample({ toolCalls: 10, fileBytes: 1_300_000 });
    assert.deepEqual(analyzeTurn(now, prev, CFG), { type: "ok" });
  });

  it("MEASURED INCIDENT: 3450 calls all rejected, +7.9 MB → burst", () => {
    const prev = sample({ fileBytes: 7_000_000 });
    const now = sample({
      toolCalls: 3450,
      rejectedCalls: 3450,
      fileBytes: 14_900_000,
      at: 2_000,
    });
    const v = analyzeTurn(now, prev, CFG);
    assert.equal(v.type, "burst");
    if (v.type === "burst") {
      assert.equal(v.toolCalls, 3450);
      assert.equal(v.rejectedCalls, 3450);
      assert.equal(v.deltaBytes, 7_900_000);
    }
  });

  it("burst is detected even without file stats (count-based)", () => {
    const prev = sample({ fileBytes: null });
    const now = sample({ toolCalls: 500, rejectedCalls: 500, fileBytes: null });
    const v = analyzeTurn(now, prev, CFG);
    assert.equal(v.type, "burst");
  });

  it("threshold boundary: exactly maxCalls → ok; maxCalls+1 → burst", () => {
    const prev = sample({});
    assert.deepEqual(analyzeTurn(sample({ toolCalls: 64 }), prev, CFG), { type: "ok" });
    assert.equal(analyzeTurn(sample({ toolCalls: 65, at: 2 }), prev, CFG).type, "burst");
  });

  it("size spike without call burst → spike", () => {
    const prev = sample({ fileBytes: 1_000_000 });
    const now = sample({ toolCalls: 2, fileBytes: 4_000_000 });
    const v = analyzeTurn(now, prev, CFG);
    assert.equal(v.type, "spike");
    if (v.type === "spike") assert.equal(v.deltaBytes, 3_000_000);
  });

  it("spike boundary: spikeBytes−1 → ok", () => {
    const prev = sample({ fileBytes: 1_000_000 });
    const now = sample({ fileBytes: 1_000_000 + CFG.spikeBytes - 1 });
    assert.deepEqual(analyzeTurn(now, prev, CFG), { type: "ok" });
  });

  it("compaction (−1 MiB or more) wins over everything; a small drop does not mask a burst", () => {
    const prev = sample({ fileBytes: 8_000_000 });
  // −1.5 MB with a 3450-call burst → COMPACTION wins (the drop is the signal)
    const compacted = analyzeTurn(
      sample({ fileBytes: 6_500_000, toolCalls: 3450, rejectedCalls: 3450 }),
      prev,
      CFG,
    );
    assert.equal(compacted.type, "compaction");
  // −0.5 MB with a 3450-call burst → not a compaction → the burst IS the verdict
    const smallDrop = analyzeTurn(
      sample({ fileBytes: 7_500_000, toolCalls: 3450, rejectedCalls: 3450 }),
      prev,
      CFG,
    );
    assert.equal(smallDrop.type, "burst");
    const tinyDrop = analyzeTurn(sample({ fileBytes: 7_999_000 }), prev, CFG);
    assert.equal(tinyDrop.type, "ok");
  });

  it("a plain smaller-file regression (no compaction) stays ok", () => {
    const prev = sample({ fileBytes: 3_000_000 });
    const now = sample({ fileBytes: 2_900_000 }); // −100 KB: rewrite, not compaction
    assert.deepEqual(analyzeTurn(now, prev, CFG), { type: "ok" });
  });
});

describe("watchdog renderVerdict", () => {
  it("burst message carries counts, size and the /compact advice", () => {
    const text = renderVerdict({
      type: "burst",
      toolCalls: 3450,
      rejectedCalls: 3450,
      deltaBytes: 7_900_000,
    });
    assert.match(text, /3450 tool calls/);
    assert.match(text, /3450 rejected/);
    assert.match(text, /\+7\.5 MB/);
    assert.match(text, /\/compact/);
  });

  it("ok renders empty (never notifies)", () => {
    assert.equal(renderVerdict({ type: "ok" }), "");
  });
});
