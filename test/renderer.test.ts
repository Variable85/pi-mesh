// test/renderer.test.ts — D41: colored rendering (aliases in accent, batch header).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colorizeAliases, renderLiveEntry, renderMeshInbound } from "../src/extension/renderer.js";

import { agentColor } from "../src/extension/colors.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

describe("colorizeAliases (D41)", () => {
  it("highlights @aliases with the AGENT color, leaves the rest untouched", () => {
    const c = agentColor("agent-2");
    const out = colorizeAliases("[mesh] @agent-2 (room cs-room, normal) hello", theme as never);
    assert.ok(out.includes(`<${c}>@agent-2</${c}>`));
    assert.ok(out.includes("(room cs-room, normal) hello"));
  });
});

describe("renderMeshInbound (D41)", () => {
  it("batch: colored header then the numbered content", () => {
    const content = "[mesh batch — 2 messages]\n1) [mesh] @agent-2 (room cs-room, normal) done";
    const lines = renderMeshInbound(content, { kind: "mesh-batch", count: 2 }, 200, theme as never);
    assert.ok(lines[0]!.includes("<accent>▚ mesh batch — 2 messages</accent>"));
    assert.ok(lines.some((l) => l.includes(`<${agentColor("agent-2")}>@agent-2</${agentColor("agent-2")}>`)));
  });

  it("simple message: sender colored, instruction line muted", () => {
    const lines = renderMeshInbound(
      "[mesh] @agent-4 (room cs-room, normal) MISSION TERMINÉE\n↩ reply with the mesh_reply tool using msgId \"m_x\"",
      { kind: "mesh-inbound", from: "agent-4" },
      200,
      theme as never,
    );
    const c = agentColor("agent-4");
    assert.ok(lines.some((l) => l.includes(`<${c}>@agent-4</${c}>`)));
    assert.ok(lines.some((l) => l.includes("<muted>↩ reply with the mesh_reply tool")));
  });

  it("wraps long lines to the width", () => {
    const long = "x".repeat(100);
    const lines = renderMeshInbound(`[mesh] @a (room r, normal) ${long}`, undefined, 40, theme as never);
    assert.ok(lines.length >= 3, `expected wrapping, got ${lines.length} lines`);
  });
});

describe("per-agent colors (D43)", () => {
  it("agentColor is stable and distinct for different aliases", () => {
    const a1 = agentColor("agent-1");
    const a2 = agentColor("agent-2");
    const again = agentColor("agent-1");
    assert.equal(a1, again, "stable for the same alias");
    assert.notEqual(a1, a2, "different agents get different colors");
  });

  it("renderLiveEntry shows the sender in its agent color", () => {
    const lines = renderLiveEntry(
      { from: "agent-7", room: "cs-room", body: "MISSION TERMINÉE", at: "2026-08-12T08:00:00.000Z" },
      200,
      theme as never,
    );
    const c = agentColor("agent-7");
    assert.ok(lines.some((l) => l.includes(`<${c}>@agent-7</${c}>`)));
    assert.ok(lines.some((l) => l.includes("MISSION TERMINÉE")));
  });
});
