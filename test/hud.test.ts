// test/hud.test.ts — pure HUD renderer: line format, dots, truncation,
// pend/failure counters, L2 activity window, no ANSI escapes (TUI-free).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePeerStatus } from "../src/client/client.js";
import { agentColor } from "../src/extension/colors.js";
import { updateSessionName } from "../src/extension/attach.js";
import {
  colorizePeerAliases,
  HUD_ACTIVITY_WINDOW_MS,
  HUD_PREVIEW_MAX,
  hudStatusText,
  renderHudLines,
  selfRooms,
  visiblePeers,
  type HudState,
} from "../src/extension/hud.js";

const NOW = 1_700_000_000_000;

function base(over: Partial<HudState> = {}): HudState {
  return {
    connected: true,
    connecting: false,
    alias: "alice",
    rooms: ["default"],
    peers: [],
    pending: 0,
    transcriptOn: true,
    ledgerFailures: 0,
    transcriptFailures: 0,
    injectionFailures: 0,
    now: NOW,
    ...over,
  };
}

describe("hud: renderHudLines L1", () => {
  it("online format with peers truncation (+n)", () => {
    const lines = renderHudLines(
      base({ peers: ["bob", "carol", "c3", "c4", "c5", "c6", "c7"], rooms: ["default", "ops"] }),
    );
    assert.equal(lines.length, 1);
    assert.equal(
      lines[0],
      "mesh ● alice @default,ops · peers: bob,carol,c3,c4,c5(+2) · tx:on",
    );
  });

  it("exactly 5 peers → no overflow suffix", () => {
    const [l1] = renderHudLines(base({ peers: ["a", "b", "c", "d", "e"] }));
    assert.ok(l1.includes("peers: a,b,c,d,e"));
    assert.ok(!l1.includes("(+"));
  });

  it("peers segment omitted when empty", () => {
    const [l1] = renderHudLines(base());
    assert.equal(l1, "mesh ● alice @default · tx:on");
  });

  it("◐ when connecting/reconnecting (not connected)", () => {
    const [l1] = renderHudLines(base({ connected: false, connecting: true }));
    assert.ok(l1.startsWith("mesh ◐ alice"));
  });

  it("○ when offline", () => {
    const [l1] = renderHudLines(base({ connected: false, connecting: false }));
    assert.ok(l1.startsWith("mesh ○ alice"));
  });

  it("pend omitted at 0, shown when > 0", () => {
    assert.ok(!renderHudLines(base({ pending: 0 }))[0].includes("pend"));
    assert.ok(renderHudLines(base({ pending: 2 }))[0].includes("pend:2"));
  });

  it("tx:off when transcript disabled", () => {
    assert.ok(renderHudLines(base({ transcriptOn: false }))[0].includes("tx:off"));
  });

  it("failure counters shown ONLY when > 0", () => {
    const clean = renderHudLines(base())[0];
    assert.ok(!clean.includes("!ledger") && !clean.includes("!transcript") && !clean.includes("!inject"));
    const dirty = renderHudLines(
      base({ ledgerFailures: 1, transcriptFailures: 2, injectionFailures: 3 }),
    )[0];
    assert.ok(dirty.includes("!ledger:1"));
    assert.ok(dirty.includes("!transcript:2"));
    assert.ok(dirty.includes("!inject:3"));
    const partial = renderHudLines(base({ ledgerFailures: 4 }))[0];
    assert.ok(partial.includes("!ledger:4") && !partial.includes("!inject"));
  });
});

describe("hud: renderHudLines L2 activity", () => {
  it("hidden when no activity", () => {
    assert.equal(renderHudLines(base()).length, 1);
  });

  it("hidden when activity older than the window", () => {
    const lines = renderHudLines(
      base({
        activity: { kind: "inbound", from: "bob", room: "ops", preview: "hi", ts: NOW - HUD_ACTIVITY_WINDOW_MS },
      }),
    );
    assert.equal(lines.length, 1);
  });

  it("shown with room, one line, HH:MM:SS time", () => {
    const lines = renderHudLines(
      base({ activity: { kind: "inbound", from: "bob", room: "ops", preview: "salut alice", ts: NOW - 5_000 } }),
    );
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /^↩ @bob \[ops\]: salut alice \d{2}:\d{2}:\d{2}$/);
  });

  it("preview truncated to ~60 chars, newlines flattened", () => {
    const long = `x\ny ${"a".repeat(200)}`;
    const lines = renderHudLines(
      base({ activity: { kind: "inbound", from: "bob", room: "", preview: long, ts: NOW - 1_000 } }),
    );
    assert.equal(lines.length, 2);
    assert.ok(!lines[1]!.includes("\n"));
    assert.ok(lines[1]!.includes("…"));
    // preview portion (between ': ' and the trailing time) ≤ HUD_PREVIEW_MAX
    const preview = lines[1]!.slice(lines[1]!.indexOf(": ") + 2, lines[1]!.length - 9);
    assert.ok(preview.length <= HUD_PREVIEW_MAX, `preview ${preview.length} > ${HUD_PREVIEW_MAX}`);
  });

  it("expired variant", () => {
    const lines = renderHudLines(
      base({ activity: { kind: "expired", msgId: "m_abc123", ts: NOW - 2_000 } }),
    );
    assert.equal(lines[1]!, "✗ expired m_abc123");
  });
});

describe("hud: purity + status text", () => {
  it("no ANSI escapes in pure output", () => {
    const lines = renderHudLines(
      base({
        peers: ["bob"],
        pending: 3,
        ledgerFailures: 1,
        activity: { kind: "inbound", from: "bob", room: "ops", preview: "hi", ts: NOW - 1_000 },
      }),
    );
    for (const line of lines) assert.ok(!line.includes("\u001b"), `ANSI in: ${line}`);
  });

  it("hudStatusText: mesh:N online, mesh:… connecting, mesh:off offline", () => {
    assert.equal(hudStatusText(base({ peers: ["a", "b", "c"] })), "mesh:3");
    assert.equal(hudStatusText(base({ connected: false, connecting: true })), "mesh:…");
    assert.equal(hudStatusText(base({ connected: false, connecting: false })), "mesh:off");
  });
});

describe("selfRooms (D27): HUD shows the session's rooms, not the mesh-wide list", () => {
  it("returns the SELF peer's rooms from the snapshot", () => {
    const snap = {
      rooms: ["cs-room", "voice"], // broker-wide — must NOT be used
      peers: [
        { alias: "main", rooms: ["voice"] },
        { alias: "agent-1", rooms: ["cs-room"] },
      ],
    };
    assert.deepEqual(selfRooms(snap, "main", ["default"]), ["voice"]);
  });

  it("falls back to local joinedRooms before the first snapshot", () => {
    assert.deepEqual(selfRooms(null, "main", ["default", "voice"]), ["default", "voice"]);
  });

  it("empty self rooms stay empty (peer left every room)", () => {
    const snap = {
      rooms: ["cs-room"],
      peers: [{ alias: "main", rooms: [] }],
    };
    assert.deepEqual(selfRooms(snap, "main", ["voice"]), []);
  });
});

describe("visiblePeers (D27): HUD peers share a room with the session", () => {
  const snap = {
    rooms: ["cs-room", "voice"],
    peers: [
      { alias: "main", rooms: ["voice"] },
      { alias: "agent-1", rooms: ["cs-room"] },
      { alias: "agent-2", rooms: ["cs-room", "voice"] },
    ],
  };

  it("a session alone in voice sees only peers sharing voice", () => {
    assert.deepEqual(visiblePeers(snap, "main", ["voice"]), ["agent-2"]);
  });

  it("a cs-room session sees only the peers sharing cs-room", () => {
    // main (voice only) shares NO room with agent-1 → not visible
    assert.deepEqual(visiblePeers(snap, "agent-1", ["cs-room"]), ["agent-2"]);
  });

  it("no snapshot → no peers yet", () => {
    assert.deepEqual(visiblePeers(null, "main", ["voice"]), []);
  });

  it("zero rooms → no visible peers (cannot talk to anyone)", () => {
    assert.deepEqual(visiblePeers(snap, "main", []), []);
  });
});

describe("computePeerStatus (D32)", () => {
  it("active under the idle threshold", () => {
    const s = computePeerStatus(new Date(Date.now() - 10_000).toISOString(), false, 120_000, 900_000);
    assert.equal(s.status, "active");
  });

  it("idle after the threshold", () => {
    const s = computePeerStatus(new Date(Date.now() - 300_000).toISOString(), false, 120_000, 900_000);
    assert.equal(s.status, "idle");
    assert.ok(s.idleFor);
  });

  it("STUCK only when idle past stuckMs AND holding reservations", () => {
    const s1 = computePeerStatus(new Date(Date.now() - 1_800_000).toISOString(), true, 120_000, 900_000);
    assert.equal(s1.status, "stuck");
    const s2 = computePeerStatus(new Date(Date.now() - 1_800_000).toISOString(), false, 120_000, 900_000);
    assert.equal(s2.status, "idle", "no reservations → idle, not stuck");
  });
});

describe("colorizePeerAliases (B5)", () => {
  it("colors exact alias tokens only — no partial matches inside longer aliases", () => {
    const fg = (color: string, text: string) => `<${color}>${text}</${color}>`;
    const out = colorizePeerAliases("peers: agent-1,agent-10,agent-2", [
      { alias: "agent-1" },
      { alias: "agent-2" },
    ], fg);
    const c1 = agentColor("agent-1");
    const c2 = agentColor("agent-2");
    assert.ok(out.includes(`<${c1}>agent-1</${c1}>`), "agent-1 colored");
    assert.ok(out.includes(`<${c2}>agent-2</${c2}>`), "agent-2 colored");
    assert.ok(out.includes("agent-10"), "agent-10 untouched (no partial recolor)");
  });

  it("colorizePeerAliases does not touch non-peer tokens", () => {
    const fg = (color: string, text: string) => `<${color}>${text}</${color}>`;
    const out = colorizePeerAliases("mesh ● alpha @cs-room", [{ alias: "beta" }], fg);
    assert.equal(out, "mesh ● alpha @cs-room");
  });
});
