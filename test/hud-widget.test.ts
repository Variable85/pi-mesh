// test/hud-widget.test.ts — REGRESSION for the pi TUI crash
// "TypeError: child.render is not a function": MeshHud.refresh() used to pass
// a FACTORY returning string[] to ctx.ui.setWidget; pi uses a factory's return
// value directly as a component (needs render(width)) → crash. This capture
// test proves EVERY setWidget payload is either undefined or a real string[].
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HUD_STATUS_ID, HUD_WIDGET_ID, MeshHud } from "../src/extension/hud.js";
import type { SessionContext } from "../src/extension/pi-types.js";
import type { MeshRuntime } from "../src/extension/tools.js";
import type { MeshFrame } from "../src/protocol/envelope.js";

type WidgetCall = { id: string; content: unknown };
type StatusCall = { id: string; text: string | undefined };

function makeCtx(): { ctx: SessionContext; widgets: WidgetCall[]; statuses: StatusCall[] } {
  const widgets: WidgetCall[] = [];
  const statuses: StatusCall[] = [];
  const ctx: SessionContext = {
    cwd: "/tmp",
    ui: {
      notify: () => {},
      setWidget: (id, content) => {
        widgets.push({ id, content });
      },
      setStatus: (id, text) => {
        statuses.push({ id, text });
      },
      theme: { fg: (_c, t) => t },
    },
  };
  return { ctx, widgets, statuses };
}

/** Assert pi-safe payload: undefined OR a real Array whose items are ALL strings. */
function assertSafeWidgetPayload(call: WidgetCall): void {
  if (call.content === undefined) return;
  assert.ok(
    Array.isArray(call.content),
    `setWidget('${call.id}') got non-array payload: ${typeof call.content}`,
  );
  for (const line of call.content as unknown[]) {
    assert.equal(typeof line, "string", `widget line not a string: ${String(line)}`);
  }
}

/** Minimal fake runtime: online client "alice", transcript on, no failures. */
function onlineRuntime(): MeshRuntime {
  return {
    client: {
      alias: "alice",
      isOnline: () => true,
      pendingCount: 0,
      status: async () => ({ peers: [], rooms: ["default"] }),
    },
    transcript: { isEnabled: () => true },
    ledgerFailures: 0,
    transcriptFailures: 0,
    injectionFailures: 0,
  } as unknown as MeshRuntime;
}

function frame(over: Partial<MeshFrame> = {}): MeshFrame {
  return {
    v: 1,
    id: "m_1",
    ts: Date.now(),
    from: "bob",
    room: "ops",
    body: "salut alice",
    ...over,
  } as MeshFrame;
}

describe("hud-widget: pi-safe setWidget payloads (crash regression)", () => {
  it("offline (no runtime): every payload is undefined or a string array", () => {
    const { ctx, widgets } = makeCtx();
    const hud = new MeshHud({ getRuntime: () => null });
    hud.attach(ctx); // → refresh()
    hud.refresh();
    hud.noteExpired("m_abc123"); // 2-line activity variant
    assert.ok(widgets.length >= 3);
    for (const call of widgets) assertSafeWidgetPayload(call);
    for (const call of widgets) {
      if (Array.isArray(call.content)) assert.ok(call.content.length >= 1);
    }
  });

  it("connecting: ◐ state payloads are string arrays", () => {
    const { ctx, widgets } = makeCtx();
    const hud = new MeshHud({ getRuntime: () => null });
    hud.attach(ctx);
    hud.setConnecting(true);
    hud.onClosed(); // reconnect marker → still connecting
    for (const call of widgets) assertSafeWidgetPayload(call);
  });

  it("online with inbound activity: payloads are string arrays, never functions", () => {
    const { ctx, widgets } = makeCtx();
    const hud = new MeshHud({ getRuntime: onlineRuntime });
    hud.attach(ctx);
    hud.noteInbound(frame()); // 2-line widget
    hud.onLocalChange();
    for (const call of widgets) assertSafeWidgetPayload(call);
    for (const call of widgets) {
      assert.notEqual(typeof call.content, "function", "factory form must be gone");
    }
  });

  it("headless (no theme): falls back to plain string[] lines", () => {
    const widgets: WidgetCall[] = [];
    const ctx: SessionContext = {
      cwd: "/tmp",
      ui: {
        notify: () => {},
        setWidget: (id, content) => {
          widgets.push({ id, content });
        },
        setStatus: () => {},
        // no theme
      },
    };
    const hud = new MeshHud({ getRuntime: () => null });
    hud.attach(ctx);
    assert.ok(widgets.length >= 1);
    for (const call of widgets) assertSafeWidgetPayload(call);
    const last = widgets.at(-1)!;
    assert.ok(Array.isArray(last.content));
    for (const line of last.content as string[]) {
      assert.ok(!line.includes(""), "plain lines expected without theme");
    }
  });

  it("detach(): clears widget (undefined) and status (undefined)", () => {
    const { ctx, widgets, statuses } = makeCtx();
    const hud = new MeshHud({ getRuntime: () => null });
    hud.attach(ctx);
    hud.detach();
    const lastWidget = widgets.at(-1)!;
    assert.equal(lastWidget.id, HUD_WIDGET_ID);
    assert.equal(lastWidget.content, undefined);
    const lastStatus = statuses.at(-1)!;
    assert.equal(lastStatus.id, HUD_STATUS_ID);
    assert.equal(lastStatus.text, undefined);
    // detach is terminal: further refresh() is a no-op
    const count = widgets.length;
    hud.refresh();
    assert.equal(widgets.length, count);
  });
});
