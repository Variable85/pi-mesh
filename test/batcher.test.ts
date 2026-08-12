// test/batcher.test.ts — D40: inbound batching (burst → one injection).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InboundBatcher, batchDetails, buildBatchMessage, bypassesBatch } from "../src/extension/batcher.js";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";

function msg(priority: "normal" | "urgent" | "force" = "normal"): MeshFrame {
  return buildFrame({ type: "msg", from: "agent-2", to: "lead", room: "cs-room", body: "hello", priority });
}

function reply(): MeshFrame {
  return buildFrame({ type: "reply", from: "agent-3", to: "lead", room: "cs-room", replyTo: "m_mission_1234567", body: "done" });
}

describe("buildBatchMessage (D40)", () => {
  it("numbers the messages and opens with the count", () => {
    const b = buildBatchMessage([msg(), reply()]);
    assert.ok(b.content.startsWith("[mesh batch — 2 messages]"));
    assert.ok(b.content.includes("1) [mesh] @agent-2"));
    assert.ok(b.content.includes("2) [mesh] @agent-3"));
    assert.ok(b.content.includes("Do NOT acknowledge them one by one."));
  });

  it("steer when the lot contains a reply or urgent; followUp for plain msgs", () => {
    assert.equal(buildBatchMessage([reply()]).deliverAs, "steer");
    assert.equal(buildBatchMessage([msg("urgent")]).deliverAs, "steer");
    assert.equal(buildBatchMessage([msg(), msg()]).deliverAs, "followUp");
  });

  it("caps the shown messages and reports the overflow", () => {
    const frames = Array.from({ length: 15 }, () => msg());
    const b = buildBatchMessage(frames);
    assert.ok(b.content.includes("(+3 more"), b.content.slice(-80));
  });

  it("details carry the per-message metadata", () => {
    const f = msg();
    const d = batchDetails([f]);
    assert.equal(d.kind, "mesh-batch");
    assert.equal(d.count, 1);
    assert.equal((d.messages as { msgId: string }[])[0]?.msgId, f.id);
  });
});

describe("InboundBatcher (D40)", () => {
  it("pushes during the window, flushes ONCE with all frames", async () => {
    let flushes = 0;
    let got: MeshFrame[] = [];
    const b = new InboundBatcher(50, (frames) => {
      flushes += 1;
      got = frames;
    });
    b.push(msg());
    b.push(msg());
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(flushes, 1);
    assert.equal(got.length, 2);
  });

  it("flushNow delivers immediately and resets", async () => {
    let flushes = 0;
    const b = new InboundBatcher(5000, () => {
      flushes += 1;
    });
    b.push(msg());
    b.flushNow();
    assert.equal(flushes, 1);
    b.flushNow();
    assert.equal(flushes, 1, "empty flush is a no-op");
  });

  it("bypassesBatch: force and remind are immediate; normal/reply are batched", () => {
    assert.equal(bypassesBatch(buildFrame({ type: "msg", from: "x", priority: "force", id: "m1" })), true);
    assert.equal(bypassesBatch(buildFrame({ type: "remind", from: "x", replyTo: "m1", id: "m2" })), true);
    assert.equal(bypassesBatch(msg()), false);
    assert.equal(bypassesBatch(reply()), false);
  });
});
