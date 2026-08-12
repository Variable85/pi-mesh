// test/renderer.test.ts — D41: colored rendering (aliases in accent, batch header).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorizeAliases, renderMeshInbound } from "../src/extension/renderer.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

describe("colorizeAliases (D41)", () => {
  it("highlights @aliases in accent, leaves the rest untouched", () => {
    const out = colorizeAliases("[mesh] @agent-2 (room cs-room, normal) hello", theme as never);
    assert.ok(out.includes("<accent>@agent-2</accent>"));
    assert.ok(out.includes("(room cs-room, normal) hello"));
  });
});

describe("renderMeshInbound (D41)", () => {
  it("batch: colored header then the numbered content", () => {
    const content = "[mesh batch — 2 messages]\n1) [mesh] @agent-2 (room cs-room, normal) done";
    const lines = renderMeshInbound(content, { kind: "mesh-batch", count: 2 }, 200, theme as never);
    assert.ok(lines[0]!.includes("<accent>▚ mesh batch — 2 messages</accent>"));
    assert.ok(lines.some((l) => l.includes("<accent>@agent-2</accent>")));
  });

  it("simple message: sender colored, instruction line muted", () => {
    const lines = renderMeshInbound(
      "[mesh] @agent-4 (room cs-room, normal) MISSION TERMINÉE\n↩ reply with the mesh_reply tool using msgId \"m_x\"",
      { kind: "mesh-inbound", from: "agent-4" },
      200,
      theme as never,
    );
    assert.ok(lines.some((l) => l.includes("<accent>@agent-4</accent>")));
    assert.ok(lines.some((l) => l.includes("<muted>↩ reply with the mesh_reply tool")));
  });

  it("wraps long lines to the width", () => {
    const long = "x".repeat(100);
    const lines = renderMeshInbound(`[mesh] @a (room r, normal) ${long}`, undefined, 40, theme as never);
    assert.ok(lines.length >= 3, `expected wrapping, got ${lines.length} lines`);
  });
});
