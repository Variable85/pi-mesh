// extension/hud.ts — mesh HUD: a live footer-widget ABOVE the Pi editor.
// renderHudLines is a PURE function (no ANSI, no I/O) → fully unit-testable
// without a TUI. MeshHud owns state + ctx.ui.setWidget/setStatus wiring.
// Body previews are transient memory only — never persisted (I1).

import type { StatusSnapshot } from "../client/client.js";
import type { MeshFrame } from "../protocol/envelope.js";
import type { SessionContext } from "./pi-types.js";
import type { GetRuntime } from "./tools.js";

export const HUD_WIDGET_ID = "mesh-hud";
export const HUD_STATUS_ID = "mesh";
export const HUD_ACTIVITY_WINDOW_MS = 90_000;
export const HUD_PEER_MAX = 5;
export const HUD_PREVIEW_MAX = 60;
/** Presence-triggered status() refreshes: at most 1/s, trailing. */
export const HUD_STATUS_REFRESH_MIN_MS = 1_000;

export type HudActivity =
  | { kind: "inbound"; from: string; room: string; preview: string; ts: number }
  | { kind: "expired"; msgId: string; ts: number };

/** Plain-data input to the pure renderer (inject `now` for tests). */
export interface HudState {
  connected: boolean;
  connecting: boolean;
  alias: string;
  rooms: string[];
  peers: string[];
  pending: number;
  transcriptOn: boolean;
  ledgerFailures: number;
  transcriptFailures: number;
  injectionFailures: number;
  activity?: HudActivity;
  now: number;
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function renderActivity(a: HudActivity): string {
  if (a.kind === "expired") return `✗ expired ${a.msgId}`;
  const time = new Date(a.ts).toTimeString().slice(0, 8); // HH:MM:SS local
  const room = a.room !== "" ? ` [${a.room}]` : "";
  return `↩ @${a.from}${room}: ${oneLine(a.preview, HUD_PREVIEW_MAX)} ${time}`;
}

/**
 * PURE renderer — no ANSI, no Pi API. 1 line normally, 2 when a recent
 * activity (< 90 s) exists. L1: connection dot (● online / ◐ connecting /
 * ○ offline), alias, rooms, peers (max 5 + overflow), pend (omit at 0),
 * tx on/off, failure counters (only when > 0).
 */
export function renderHudLines(state: HudState): [string, ...string[]] {
  const dot = state.connected ? "●" : state.connecting ? "◐" : "○";
  let head = `mesh ${dot} ${state.alias}`;
  if (state.rooms.length > 0) head += ` @${state.rooms.join(",")}`;
  const segs: string[] = [head];
  if (state.peers.length > 0) {
    const shown = state.peers.slice(0, HUD_PEER_MAX);
    const extra = state.peers.length - shown.length;
    segs.push(`peers: ${shown.join(",")}${extra > 0 ? `(+${extra})` : ""}`);
  }
  if (state.pending > 0) segs.push(`pend:${state.pending}`);
  segs.push(`tx:${state.transcriptOn ? "on" : "off"}`);
  if (state.ledgerFailures > 0) segs.push(`!ledger:${state.ledgerFailures}`);
  if (state.transcriptFailures > 0) segs.push(`!transcript:${state.transcriptFailures}`);
  if (state.injectionFailures > 0) segs.push(`!inject:${state.injectionFailures}`);
  const lines: [string, ...string[]] = [segs.join(" · ")];
  const a = state.activity;
  if (a !== undefined && state.now - a.ts < HUD_ACTIVITY_WINDOW_MS) {
    lines.push(renderActivity(a));
  }
  return lines;
}

/** Compact footer status text. */
export function hudStatusText(state: HudState): string {
  if (state.connected) return `mesh:${state.peers.length}`;
  if (state.connecting) return "mesh:…";
  return "mesh:off";
}

/**
 * MeshHud — owns HUD state (last status snapshot, last activity) and pushes
 * it to the TUI. refresh() eagerly computes the colorized string[] (via
 * ctx.ui.theme, falling back to plain lines when unavailable) and calls
 * setWidget with the SAFE array form only — NEVER a factory: pi uses a
 * factory's return value directly as a component, so returning string[]
 * crashes the TUI (child.render is not a function).
 */
export class MeshHud {
  private ctx: SessionContext | null = null;
  private snapshot: StatusSnapshot | null = null;
  private activity: HudActivity | null = null;
  private connecting = false;
  private statusTimer: NodeJS.Timeout | null = null;
  private lastStatusFetchAt = 0;

  constructor(private readonly deps: { getRuntime: GetRuntime }) {}

  attach(ctx: SessionContext): void {
    this.ctx = ctx;
    this.refresh();
  }

  /** session_shutdown: clear BOTH widget and status. */
  detach(): void {
    const ctx = this.ctx;
    this.ctx = null;
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (ctx !== null) {
      ctx.ui.setWidget(HUD_WIDGET_ID, undefined);
      ctx.ui.setStatus(HUD_STATUS_ID, undefined);
    }
  }

  setConnecting(on: boolean): void {
    this.connecting = on;
    this.refresh();
  }

  /** 'closed': mark offline + clear peers (client auto-reconnects → ◐). */
  onClosed(): void {
    this.snapshot = null;
    this.connecting = true;
    this.refresh();
  }

  /** Inbound frame: L2 activity preview — transient memory only, never persisted. */
  noteInbound(frame: MeshFrame): void {
    this.activity = {
      kind: "inbound",
      from: frame.from ?? "?",
      room: frame.room ?? "",
      preview: frame.body ?? "",
      ts: Date.now(),
    };
    this.refresh();
  }

  noteExpired(msgId: string): void {
    this.activity = { kind: "expired", msgId, ts: Date.now() };
    this.refresh();
  }

  /** Presence-driven status() refresh: at most 1/s, trailing. */
  scheduleStatusRefresh(): void {
    if (this.statusTimer !== null) return; // trailing refresh already queued
    const wait = Math.max(0, HUD_STATUS_REFRESH_MIN_MS - (Date.now() - this.lastStatusFetchAt));
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.fetchStatus();
    }, wait);
    this.statusTimer.unref();
  }

  /** Local change (join/leave/log toggle): repaint + resync snapshot. */
  onLocalChange(): void {
    this.refresh();
    this.scheduleStatusRefresh();
  }

  /** Fire-and-forget status() → snapshot. NEVER blocks session lifecycle. */
  fetchStatus(): void {
    const rt = this.deps.getRuntime();
    if (rt === null || !rt.client.isOnline()) {
      this.refresh();
      return;
    }
    this.lastStatusFetchAt = Date.now();
    rt.client
      .status()
      .then((snap) => {
        this.snapshot = snap;
        this.refresh();
      })
      .catch(() => {});
  }

  refresh(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const state = this.buildState();
    ctx.ui.setWidget(HUD_WIDGET_ID, this.colorize(renderHudLines(state), state));
    ctx.ui.setStatus(HUD_STATUS_ID, hudStatusText(state));
  }

  /** Eager colorization at refresh time; plain lines when no theme (headless). */
  private colorize(lines: [string, ...string[]], state: HudState): string[] {
    const theme = this.ctx?.ui.theme;
    if (theme === undefined) return lines;
    const color = state.connected ? "success" : state.connecting ? "warning" : "muted";
    return lines.map((line, i) =>
      i === 0 ? theme.fg(color, line) : theme.fg("muted", line),
    );
  }

  private buildState(): HudState {
    const rt = this.deps.getRuntime();
    const self = rt?.client.alias ?? "";
    return {
      connected: rt?.client.isOnline() === true,
      connecting: this.connecting,
      alias: self !== "" ? self : "?",
      rooms: this.snapshot?.rooms ?? [],
      peers: (this.snapshot?.peers ?? []).map((p) => p.alias).filter((a) => a !== self),
      pending: rt?.client.pendingCount ?? 0,
      transcriptOn: rt?.transcript.isEnabled() === true,
      ledgerFailures: rt?.ledgerFailures ?? 0,
      transcriptFailures: rt?.transcriptFailures ?? 0,
      injectionFailures: rt?.injectionFailures ?? 0,
      activity: this.activity ?? undefined,
      now: Date.now(),
    };
  }
}
