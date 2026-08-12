// extension/renderer.ts — colored rendering of mesh messages in
// the conversation, INSIDE the pi custom-message box (background
// customMessageBg — the "purple frame" of the default rendering,.
// Per-agent colors everywhere: simple messages, batches and live entries.
// No Pi imports except pi-tui helpers (wrap + visibleWidth).
import { visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { ALIAS_RE, agentColor } from "./colors.js";
import type { ThemeBg, ThemeColor } from "./pi-types.js";

export interface RenderTheme {
  fg(color: ThemeColor, text: string): string;
  /** background application (theme.bg) — absent in tests/headless. */
  bg?(color: ThemeBg, text: string): string;
  /** Bold helper (theme.bold) for the box label. */
  bold?(text: string): string;
  /** Raw foreground ANSI code for a theme color — the verdict lines use it
   *  to build the per-agent BACKGROUND (38→48). */
  fgAnsi?(color: ThemeColor): string;
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

/** Live entry payload (mesh-live,. */
export interface LiveEntryData {
  from?: string;
  room?: string;
  priority?: string;
  body?: string;
  at?: string;
}

/**
 * reproduce pi's default custom-message Box — background
 * customMessageBg, padding X=1/Y=1 — around OUR colored content, so mesh
 * messages get the "purple frame" back while keeping per-agent colors.
 * Falls back to plain lines when the theme has no bg (tests/headless).
 */
export function renderBox(
  contentLines: string[],
  width: number,
  theme: RenderTheme,
  label = "[mesh-inbound]",
): string[] {
  const bg = theme.bg;
  if (bg === undefined) return contentLines;
  const inner = Math.max(1, width - 2);
  const out: string[] = [];
  const emptyLine = bg("customMessageBg", " ".repeat(Math.max(0, width)));
  out.push(emptyLine); // padding Y=1 top
  // Label line (like pi's default box): [customType] bold in customMessageLabel
  const labelText = theme.bold !== undefined ? theme.bold(label) : label;
  out.push(padBg(bg, theme.fg("customMessageLabel", labelText), width));
  out.push(emptyLine); // spacer
  for (const raw of contentLines) {
    if (raw === "") {
      out.push(emptyLine);
      continue;
    }
  // wrap to the inner width (padding X=1 on both sides), then pad the rest
    for (const l of wrapTextWithAnsi(raw, inner)) {
      out.push(padBg(bg, l, width));
    }
  }
  out.push(emptyLine); // padding Y=1 bottom
  return out;
}

/** Left-pad X=1, fill the remaining width with spaces, apply the background. */
function padBg(
  bg: (color: ThemeBg, text: string) => string,
  line: string,
  width: number,
): string {
  const vis = visibleWidth(line);
  const padded = ` ${line}${" ".repeat(Math.max(0, width - vis - 1))}`;
  return bg("customMessageBg", padded);
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

/** Render a mesh message (simple or batch) as a boxed, colored component. */
export function renderMeshInbound(
  content: string,
  details: MeshInboundDetails | undefined,
  width: number,
  theme: RenderTheme,
): string[] {
  const inner: string[] = [];
  if (details?.kind === "mesh-batch" && typeof details.count === "number") {
    inner.push(theme.fg("accent", `▚ mesh batch — ${details.count} messages`));
  }
  for (const raw of content.split("\n")) pushLine(inner, raw, width, theme);
  return renderBox(inner, width, theme);
}

/** Live inbound entry rendered while the agent is busy. */
export function renderLiveEntry(
  data: LiveEntryData | undefined,
  width: number,
  theme: RenderTheme,
): string[] {
  if (data === undefined || data.from === undefined) {
    return renderBox([theme.fg("dim", "[mesh]")], width, theme);
  }
  const sender = colorizeSender(data.from, theme.fg);
  const room = data.room !== undefined ? theme.fg("dim", ` [${data.room}]`) : "";
  const time = data.at !== undefined ? theme.fg("dim", ` ${data.at.slice(11, 19)}`) : "";
  const body = (data.body ?? "").replace(/\s+/g, " ").trim();
  const head = `⇠ ${sender}${room}${time}`;
  const inner = [...wrapTextWithAnsi(head, width)];
  if (body.length > 0) {
    inner.push(...wrapTextWithAnsi(colorizeAliases(body, theme), width));
  }
  return renderBox(inner, width, theme, "[mesh-live]");
}

function colorizeSender(alias: string, fg: (color: ThemeColor, text: string) => string): string {
  return fg(agentColor(alias), `@${alias}`);
}

/** Verdict entry payload (mesh-verdict — the colored wait_all result). */
export interface VerdictEntryData {
  head?: string;
  answers?: { to: string; response: string }[];
  missing?: { to: string; msgId: string }[];
}

/** ANSI background code for a theme color (38→48 on the raw foreground
 *  code; works for 256-color and truecolor sequences). */
export function ansiBackground(color: ThemeColor, theme: RenderTheme): string | undefined {
  const fg = theme.fgAnsi?.(color);
  if (fg === undefined || !fg.includes("38")) return undefined;
  return fg.replace("38", "48");
}

/** One verdict line: text in the agent's fg color, FULL-WIDTH background in
 *  the agent's color (padded to `width`). */
function verdictLine(
  marker: string,
  to: string,
  text: string,
  width: number,
  theme: RenderTheme,
): string {
  const color = agentColor(to);
  const body = `${marker} @${to}: ${text}`;
  const bg = ansiBackground(color, theme);
  // readable: neutral text on the agent-colored background; without a theme
  // the agent color is used for the text (plain background)
  if (bg === undefined) return theme.fg(color, body);
  const colored = theme.fg("text", body);
  const vis = visibleWidth(colored);
  return `${bg}${colored}${" ".repeat(Math.max(0, width - vis))}\x1b[49m`;
}

/** The wait_all verdict rendered as a colored entry: header in accent on the
 *  default box background, then one line per agent with the AGENT color as
 *  text AND background. Falls back to plain lines without a theme. */
export function renderVerdictEntry(
  data: VerdictEntryData | undefined,
  width: number,
  theme: RenderTheme,
): string[] {
  const head = data?.head ?? "wait_all";
  const out: string[] = [];
  const pad = (l: string): string => `${l}${" ".repeat(Math.max(0, width - visibleWidth(l)))}`;
  // header on the neutral box background, with an empty line ABOVE (the
  // entry must not touch the previous content) and BELOW (before the lines)
  const bg = theme.bg;
  if (bg !== undefined) {
    out.push(bg("customMessageBg", " ".repeat(Math.max(0, width))));
    out.push(bg("customMessageBg", pad(theme.fg("accent", `▚ ${head}`))));
    out.push(bg("customMessageBg", " ".repeat(Math.max(0, width))));
  } else {
    out.push("");
    out.push(theme.fg("accent", head));
  }
  for (const a of data?.answers ?? []) {
    out.push(verdictLine("✓", a.to, a.response.replace(/\s+/g, " ").trim().slice(0, 120), width, theme));
  }
  for (const m of data?.missing ?? []) {
    out.push(verdictLine("✗", m.to, `NOT ANSWERED (${m.msgId.slice(0, 18)})`, width, theme));
  }
  return out;
}
