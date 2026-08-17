// test/session-report.test.ts — v0.5.3 report: runs scripts/session-report.mjs
// against a fixture session + ledger and asserts the findings (burst, size,
// rejected, latency medians, reservations). Executed as a child process; the
// script is a standalone CLI with its own arg parsing.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileP = promisify(execFile);
/** execFile but keeps stdout when the script exits 1 (findings found). */
const runReport = async (args: string[]): Promise<string> => {
  try {
    const r = await execFileP(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    return r.stdout;
  } catch (err) {
    const e = err as { stdout?: string; killed?: boolean };
    if (e.killed !== true && typeof e.stdout === "string") return e.stdout; // exit 1 = findings
    throw err;
  }
};

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/session-report.mjs");

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mesh-report-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const iso = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

function writeSession(sessionsDir: string, name: string, turns: unknown[]): void {
  const sub = path.join(sessionsDir, "proj");
  mkdirSync(sub, { recursive: true });
  const lines = turns.map((t) => JSON.stringify(t));
  writeFileSync(path.join(sub, `${name}.jsonl`), lines.join("\n") + "\n");
}

describe("session-report v2 (v0.5.3)", () => {
  it("flags burst + rejected results + big file + reservations, and reports latency medians", async () => {
    const { dir, cleanup } = tmp();
    try {
      // --- fixture session: normal turns, then one degenerate burst ---
      const base = Date.now() - 60_000;
      const ts = (i: number) => new Date(base + i * 1000).toISOString();
      const turns: unknown[] = [];
      // 12 healthy turns with 15 s generation latency each
      for (let i = 0; i < 12; i += 1) {
        turns.push({ type: "message", timestamp: ts(i * 30), message: { role: "user", content: "go" } });
        turns.push({ type: "message", timestamp: ts(i * 30 + 15), message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] } });
        turns.push({ type: "message", timestamp: ts(i * 30 + 15), message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } });
      }
      // the burst: 60 identical rejected calls in ONE assistant message
      const burstCalls = Array.from({ length: 60 }, () => ({ type: "toolCall", name: "bash", arguments: { command: "node --check /tmp/x.js" } }));
      turns.push({ type: "message", timestamp: ts(40), message: { role: "user", content: "patch" } });
      turns.push({ type: "message", timestamp: ts(41), message: { role: "assistant", content: burstCalls } });
      for (let i = 0; i < 60; i += 1) {
        turns.push({ type: "message", timestamp: ts(41), message: { role: "toolResult", content: [{ type: "text", text: "Tool call was not executed: output token limit" }] } });
      }
      writeSession(path.join(dir, "sessions"), "burst-agent", turns);
      // pad the file past 5 MB so the size flag fires too
      const big = path.join(dir, "sessions", "proj", "burst-agent.jsonl");
      const filler = JSON.stringify({ type: "message", timestamp: ts(0), message: { role: "user", content: "x".repeat(64 * 1024) } });
      const pad = Array(85).fill(filler).join("\n"); // ~5.5 MB
      appendFileSync(big, "\n" + pad + "\n");

      // --- fixture ledger: one leaked reservation, one blocked send ---
      mkdirSync(path.join(dir, "mesh"), { recursive: true });
      const now = iso(0);
      const blocked = JSON.stringify({ schema: "mesh.ledger.v1", event: "blocked", from: "a", to: "b", code: "invalid_target", ts: now, bodyStored: false });
      writeFileSync(
        path.join(dir, "mesh", "ledger.jsonl"),
        [
          JSON.stringify({ schema: "mesh.ledger.v1", event: "reserved", from: "agent-1", refs: ["a.js"], ts: now, bodyStored: false }),
          JSON.stringify({ schema: "mesh.ledger.v1", event: "sent", from: "a", to: "b", ts: now, bodyStored: false }),
          blocked,
          blocked,
          blocked,
        ].join("\n") + "\n",
      );

      const out = await runReport([
        "--sessions", path.join(dir, "sessions"),
        "--ledger", path.join(dir, "mesh", "ledger.jsonl"),
        "--hours", "24",
        "--json",
      ]);
      const report = JSON.parse(out) as {
        sessions: { name: string; bursts: number; maxCalls: number; rejected: number; mb: number; latency: { median: number; recentMedian: number } | null }[];
        problems: string[];
      };
      const s = report.sessions.find((x) => x.name === "burst-agent");
      assert.ok(s, "fixture session listed");
      assert.equal(s!.bursts, 1, "the 60-call message is a burst");
      assert.equal(s!.maxCalls, 60);
      assert.equal(s!.rejected, 60);
      assert.ok(s!.mb > 5, `size > 5 MB (got ${s!.mb})`);
      assert.ok(s!.latency !== null);
      assert.ok(s!.latency!.median >= 14 && s!.latency!.median <= 16, `median ≈ 15s (got ${s!.latency!.median})`);
      const blob = report.problems.join(" | ");
      assert.match(blob, /burst message/);
      assert.match(blob, /invalid_target/);
    } finally {
      cleanup();
    }
  });

  it("flags RECENT degradation when the last 20 turns are slow but the session median is fine", async () => {
    const { dir, cleanup } = tmp();
    try {
      const base = Date.now() - 3_600_000;
      const ts = (i: number) => new Date(base + i * 1000).toISOString();
      const turns: unknown[] = [];
      // 30 turns at 5 s (healthy history)…
      for (let i = 0; i < 30; i += 1) {
        turns.push({ type: "message", timestamp: ts(i * 4), message: { role: "user", content: "go" } });
        turns.push({ type: "message", timestamp: ts(i * 4 + 5), message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] } });
        turns.push({ type: "message", timestamp: ts(i * 4 + 5), message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } });
      }
      // …then 20 turns at 150 s (post-incident degradation)
      for (let i = 0; i < 20; i += 1) {
        turns.push({ type: "message", timestamp: ts(200 + i * 160), message: { role: "user", content: "go" } });
        turns.push({ type: "message", timestamp: ts(200 + i * 160 + 150), message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] } });
        turns.push({ type: "message", timestamp: ts(200 + i * 160 + 150), message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } });
      }
      writeSession(path.join(dir, "sessions"), "degraded", turns);

      const out = await runReport([
        "--sessions", path.join(dir, "sessions"),
        "--ledger", path.join(dir, "none.jsonl"),
        "--hours", "24",
        "--json",
      ]);
      const report = JSON.parse(out) as {
        sessions: { name: string; latency: { median: number; recentMedian: number; n: number } | null }[];
        problems: string[];
      };
      const s = report.sessions.find((x) => x.name === "degraded");
      assert.ok(s?.latency, "latency measured");
      // median over 50 turns ≈ 5s-ish; the LAST 20 are 150s
      assert.ok(s!.latency!.median < 60, `session median healthy (got ${s!.latency!.median})`);
      assert.ok(s!.latency!.recentMedian >= 149, `recent median degraded (got ${s!.latency!.recentMedian})`);
      assert.match(report.problems.join(" | "), /RECENT turns at \d+s median/);
    } finally {
      cleanup();
    }
  });

  it("clean sessions → no problems, exit 0", async () => {
    const { dir, cleanup } = tmp();
    try {
      const turns = [
        { type: "message", timestamp: iso(-60_000), message: { role: "user", content: "hi" } },
        { type: "message", timestamp: iso(-50_000), message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] } },
        { type: "message", timestamp: iso(-50_000), message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
      ];
      writeSession(path.join(dir, "sessions"), "healthy", turns);
      const out = await runReport(["--sessions", path.join(dir, "sessions"), "--ledger", path.join(dir, "none.jsonl")]);
      assert.match(out, /✔ no problems detected/);
    } finally {
      cleanup();
    }
  });
});
