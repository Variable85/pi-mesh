// test/context-diff.test.ts — M2 reconnect diff + formatOptsFor wiring:
// the full mesh-context block goes out once per session; reconnects send a
// one-line peer diff instead (cs-master measured: 5× the ~500-token block).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFrame } from "../src/protocol/envelope.js";
import { buildReconnectDiff, formatOptsFor } from "../src/extension/attach.js";
import { ReplyHintTracker } from "../src/extension/reply-hints.js";

describe("buildReconnectDiff", () => {
  it("joined and left peers are listed compactly", () => {
    const line = buildReconnectDiff(["agent-1", "agent-2", "agent-3"], ["agent-1", "agent-3", "agent-9"]);
    assert.ok(line.startsWith("[mesh] reconnected"));
    assert.ok(line.includes("+@agent-9"), line);
    assert.ok(line.includes("−@agent-2"), line);
  });

  it("no membership change → 'No peer changes.'", () => {
    const line = buildReconnectDiff(["agent-1"], ["agent-1"]);
    assert.ok(line.includes("No peer changes."), line);
  });

  it("always points to mesh_status for the full picture", () => {
    const line = buildReconnectDiff([], ["agent-1"]);
    assert.ok(line.includes("mesh_status"), line);
  });
});

describe("formatOptsFor", () => {
  const f = buildFrame({ type: "msg", from: "bob", to: "me", room: "cs-room", body: "hi" });

  it("compact default: verbose=false, hint from the tracker, homeRoom threaded", () => {
    const hints = new ReplyHintTracker(() => 1_000);
    const o = formatOptsFor(f, false, "cs-room", hints);
    assert.equal(o.verbose, false);
    assert.equal(o.homeRoom, "cs-room");
    assert.equal(o.showReplyHint, true); // first sight from bob
    assert.equal(formatOptsFor(f, false, "cs-room", hints).showReplyHint, false);
  });

  it("verbose mode passes through (contextVerbosity full)", () => {
    const o = formatOptsFor(f, true, "default", new ReplyHintTracker(() => 1));
    assert.equal(o.verbose, true);
  });
});
