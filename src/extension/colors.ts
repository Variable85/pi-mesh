// extension/colors.ts — D43: per-agent colors. Each alias gets a STABLE
// color from the pi theme palette so agents are recognizable visually
// everywhere (messages, batches, live entries, HUD).
import type { ThemeColor } from "./pi-types.js";

/** Distinct theme colors (accent + statuses + syntax palette). */
export const AGENT_COLORS: readonly ThemeColor[] = [
  "accent",
  "success",
  "warning",
  "error",
  "customMessageText",
  "syntaxString",
  "syntaxKeyword",
  "syntaxNumber",
  "syntaxType",
  "syntaxFunction",
  "syntaxComment",
  "dim",
] as const;

/** Stable color for an alias (hash → palette index). */
export function agentColor(alias: string): ThemeColor {
  let h = 0;
  for (let i = 0; i < alias.length; i += 1) {
    h = (h * 31 + alias.charCodeAt(i)) >>> 0;
  }
  return AGENT_COLORS[h % AGENT_COLORS.length] ?? "accent";
}

/** Colorize a sender alias with its agent color. */
export function colorizeSender(
  alias: string,
  fg: (color: ThemeColor, text: string) => string,
): string {
  return fg(agentColor(alias), `@${alias}`);
}

/** Full alias regex (used by renderers to recolor raw lines). */
export const ALIAS_RE = /(@[a-z0-9][a-z0-9-]*)/g;
