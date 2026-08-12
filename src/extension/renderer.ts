// extension/renderer.ts — D41/D43: colored rendering of mesh messages in the
// conversation. Per-agent colors everywhere: simple messages, batches and
// live entries. No Pi imports except pi-tui helpers (wrap).
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { ALIAS_RE, agentColor } from "./colors.js";
import type { ThemeColor } from "./pi-types.js";

export interface RenderTheme {
  fg(color: ThemeColor, text: string): string;
}

/** Colorize every @alias in a line with its OWN agent color. */
export function colorizeAliases(line: string, theme: RenderTheme): string {
  return line.replace(ALIAS_RE, (m) => theme.fg(agentColor(m.slice(1)), m));
}

export interface MeshInboundDetails {
  kind?: string;
  count?: number;
  msgId?: string;
  from?: string;
  room?: string;
  priority?: string;
}

/** Live entry payload (mesh-live, D43). */
export interface LiveEntryData {
  from?: string;
  room?: string;
  priority?: string;
  body?: string;
  at?: string;
}

function pushLine(out: string[], line: string, width: number, theme: RenderTheme): void {
  if (line.trim() === "") {
    out.push("");
    return;
  }
  let colored = line;
  if (line.startsWith("↩")) colored = theme.fg("muted", line);
  out.push(...wrapTextWithAnsi(colorizeAliases(colored, theme), width));
}

export function renderMeshInbound(
  content: string,
  details: MeshInboundDetails | undefined,
  width: number,
  theme: RenderTheme,
): string[] {
  const out: string[] = [];
  if (details?.kind === "mesh-batch" && typeof details.count === "number") {
    out.push(theme.fg("accent", `▚ mesh batch — ${details.count} messages`));
  }
  for (const raw of content.split("\n")) pushLine(out, raw, width, theme);
  return out;
}

/** Live inbound entry rendered while the agent is busy (D43). */
export function renderLiveEntry(
  data: LiveEntryData | undefined,
  width: number,
  theme: RenderTheme,
): string[] {
  if (data === undefined || data.from === undefined) return [theme.fg("dim", "[mesh]")];
  const sender = colorizeSender(data.from, theme.fg);
  const room = data.room !== undefined ? theme.fg("dim", ` [${data.room}]`) : "";
  const time = data.at !== undefined ? theme.fg("dim", ` ${data.at.slice(11, 19)}`) : "";
  const body = (data.body ?? "").replace(/\s+/g, " ").trim();
  const head = `⇠ ${sender}${room}${time}`;
  const out = [...wrapTextWithAnsi(head, width)];
  if (body.length > 0) {
    out.push(...wrapTextWithAnsi(colorizeAliases(body, theme), width));
  }
  return out;
}

function colorizeSender(alias: string, fg: (color: ThemeColor, text: string) => string): string {
  return fg(agentColor(alias), `@${alias}`);
}
