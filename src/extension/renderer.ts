// extension/renderer.ts — D41: colored rendering of mesh messages in the
// conversation. The batch is a colored header + the numbered list with
// sender aliases in accent; simple messages get their sender highlighted.
// No Pi imports except pi-tui helpers (like the classic pi-mesh overlay).
import { wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { ThemeColor } from "./pi-types.js";

export interface RenderTheme {
  fg(color: ThemeColor, text: string): string;
}

const ALIAS_RE = /(@[a-z0-9][a-z0-9-]*)/g;

/** Colorize sender aliases inside a line (accent). */
export function colorizeAliases(line: string, theme: RenderTheme): string {
  return line.replace(ALIAS_RE, (m) => theme.fg("accent", m));
}

export interface MeshInboundDetails {
  kind?: string;
  count?: number;
  msgId?: string;
  from?: string;
  room?: string;
  priority?: string;
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
  for (const raw of content.split("\n")) {
    if (raw.trim() === "") {
      out.push("");
      continue;
    }
    // instructions / INFO ONLY lines get a muted style hint
    let line = raw;
    if (line.startsWith("↩")) line = theme.fg("muted", line);
    out.push(...wrapTextWithAnsi(colorizeAliases(line, theme), width));
  }
  return out;
}
