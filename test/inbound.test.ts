// test/inbound.test.ts — injected content format: first line byte-identical
// (§9.1, HUD/docs depend on it), plus an explicit mesh_reply instruction line
// carrying the exact msgId so the receiving model knows HOW to answer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatInboundContent } from "../src/extension/inbound.js";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";

const msgFrame = (): MeshFrame =>
  buildFrame({ type: "msg", from: "alice", to: "bob", room: "default", body: "hello" });

describe("formatInboundContent: first line stays byte-identical (§9.1)", () => {
  it("msg frame first line is exactly `[mesh] @from (room X, priority) body`", () => {
    const f = msgFrame();
    const firstLine = formatInboundContent(f).split("\n")[0];
    assert.equal(firstLine, "[mesh] @alice (room default, normal) hello");
  });

  it("mailbox frame keeps the same first-line format", () => {
    const f = buildFrame({
      type: "mailbox",
      from: "alice",
      to: "bob",
      room: "ops",
      priority: "urgent",
      body: "queued",
    });
    const firstLine = formatInboundContent(f).split("\n")[0];
    assert.equal(firstLine, "[mesh] @alice (room ops, urgent) queued");
  });
});

describe("formatInboundContent: mesh_reply instruction line", () => {
  it("msg frame carries a 2nd line instructing reply via mesh_reply with the exact msgId", () => {
    const f = msgFrame();
    const content = formatInboundContent(f);
    const lines = content.split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], `↩ reply with the mesh_reply tool using msgId "${f.id}"`);
  });

  it("mailbox frame carries the same msgId instruction line", () => {
    const f = buildFrame({ type: "mailbox", from: "alice", to: "bob", body: "queued" });
    const content = formatInboundContent(f);
    assert.ok(
      content.includes(`\n↩ reply with the mesh_reply tool using msgId "${f.id}"`),
      `mailbox content must include the msgId instruction line, got: ${content}`,
    );
  });

  it("empty-body msg frame still carries the instruction line", () => {
    const f = buildFrame({ type: "msg", from: "alice", to: "bob" });
    const content = formatInboundContent(f);
    assert.ok(content.endsWith(`↩ reply with the mesh_reply tool using msgId "${f.id}"`));
  });
});

describe("formatInboundContent: remind frames carry the replyTo instruction", () => {
  it("remind uses frame.replyTo in the instruction when present", () => {
    const f = buildFrame({ type: "remind", from: "broker", to: "bob", replyTo: "msg-123" });
    const content = formatInboundContent(f);
    assert.equal(
      content,
      '[mesh] @broker (room default, normal) reminder: reply due for msg-123' +
        ' — reply with the mesh_reply tool using msgId "msg-123"',
    );
  });

  it("remind falls back to frame.id when replyTo is absent", () => {
    // defensive fallback: a remind frame without replyTo (buildFrame does not
    // enforce replyTo; validation is a separate step).
    const f = buildFrame({ type: "remind", from: "broker", to: "bob" });
    assert.equal(f.replyTo, undefined);
    const content = formatInboundContent(f);
    assert.ok(
      content.includes(`reply due for ${f.id} — reply with the mesh_reply tool using msgId "${f.id}"`),
      `remind must fall back to frame.id, got: ${content}`,
    );
  });
});

describe("formatInboundContent: orphan replies (the cs-room fix)", () => {
  it("reply frame is labelled as an answer to the original msgId", () => {
    const f = buildFrame({
      type: "reply",
      from: "bob",
      to: "alice",
      room: "cs-room",
      replyTo: "m_orig_12345678",
      body: "MISSION COMPLETE",
    });
    const content = formatInboundContent(f);
    assert.ok(
      content.startsWith("[mesh] @bob (room cs-room, normal) reply to m_orig_12345678: MISSION COMPLETE"),
      `got: ${content}`,
    );
    assert.ok(
      content.includes(`answer back with the mesh_reply tool using msgId "${f.id}"`),
      `got: ${content}`,
    );
  });
});
