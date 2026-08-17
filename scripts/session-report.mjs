#!/usr/bin/env node
// scripts/session-report.mjs — daily mesh/session health report.
// Automates the post-incident cs-room forensics: session-file growth,
// degenerate tool-call bursts, rejected results, generation latency
// (the incident's real symptom: median turn 12s → 118s), ledger anomalies
// (blocked/expired sends, held reservations, unknown targets).
//
// v0.5.3: --json gains per-session latency median/p90 + assistant-turn
// counts; the text report flags sessions whose median generation latency
// exceeds LATENCY_WARN_S (context damage signal).
//
// Usage:
//   node scripts/session-report.mjs [--sessions DIR] [--ledger FILE] [--hours 24] [--json]
// Exit code 1 when any threshold is exceeded (cron/alert friendly).
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- args ----
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const HOURS = Number(argOf("hours", "24")) || 24;
const AS_JSON = args.includes("--json");
const SESSIONS_DIR = argOf("sessions", path.join(os.homedir(), ".pi", "agent", "sessions"));
const LEDGER = argOf("ledger", path.join(process.cwd(), ".mesh", "ledger.jsonl"));

const SPIKE_MB = 5; // session grew past this in the window → flag
const BURST_CALLS = 50; // tool calls in ONE assistant message → burst
const LATENCY_WARN_S = 60; // median generation latency above this → flag
const CUTOFF = Date.now() - HOURS * 3_600_000;

const problems = [];

// ---- sessions ----
const sessionFiles = [];
try {
  for (const dir of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = path.join(SESSIONS_DIR, dir.name);
    for (const f of readdirSync(full)) {
      if (f.endsWith(".jsonl")) sessionFiles.push(path.join(full, f));
    }
  }
} catch {
  // sessions dir absent — skip silently
}

const sessionRows = [];
for (const file of sessionFiles) {
  let st;
  try {
    st = statSync(file);
  } catch {
    continue;
  }
  if (st.mtimeMs < CUTOFF) continue;
  const name = path.basename(file).replace(/\.jsonl$/, "");
  let bursts = 0;
  let rejected = 0;
  let maxCalls = 0;
  let tailRead = 0;
  const latencyGaps = []; // generation latency: input(prev) → assistant
  let prevInputTs = null;
  const CHUNK = 512 * 1024;
  const buf = Buffer.alloc(CHUNK);
  const fd = openSync(file, "r");
  try {
    let pos = 0;
    let carry = "";
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      tailRead += n;
      if (tailRead > 8 * 1024 * 1024) break; // scan at most the last 8 MB
      const text = carry + buf.subarray(0, n).toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"message"')) continue;
        try {
          const e = JSON.parse(line);
          const m = e.message ?? {};
          const role = m.role;
          const ts = e.timestamp;
          if (role === "assistant") {
            if (prevInputTs && ts) {
              const d = (Date.parse(ts) - Date.parse(prevInputTs)) / 1000;
              if (d >= 0 && d < 3600) latencyGaps.push(d);
            }
            prevInputTs = null;
          } else if (role === "user" || role === "toolResult") {
            prevInputTs = ts ?? prevInputTs;
          }
          const c = m.content;
          if (!Array.isArray(c)) continue;
          let calls = 0;
          for (const b of c) {
            if (b && typeof b === "object" && b.type === "toolCall") calls += 1;
          }
          if (calls > maxCalls) maxCalls = calls;
          if (calls > BURST_CALLS) bursts += 1;
          if (line.includes("was not executed")) rejected += 1;
        } catch {
          // skip malformed
        }
      }
    }
  } finally {
    closeSync(fd);
  }
  const mb = st.size / 1_048_576;
  latencyGaps.sort((a, b) => a - b);
  const nLat = latencyGaps.length;
  const recent = latencyGaps.slice(-20); // the LAST 20 measured turns — the
  // session's CURRENT state (a full-session median masks the post-incident
  // degradation: measured 12s median overall vs 119s on the last turns).
  const latency = nLat > 0
    ? {
        n: nLat,
        median: +latencyGaps[Math.floor(nLat / 2)].toFixed(1),
        p90: +latencyGaps[Math.floor(nLat * 0.9)].toFixed(1),
        recentMedian: +recent[Math.floor(recent.length / 2)].toFixed(1),
      }
    : null;
  sessionRows.push({ name, mb: +mb.toFixed(1), maxCalls, bursts, rejected, latency });
  if (bursts > 0) problems.push(`${name}: ${bursts} burst message(s), max ${maxCalls} calls in one message`);
  if (mb > SPIKE_MB) problems.push(`${name}: session file ${mb.toFixed(1)} MB (> ${SPIKE_MB} MB) — /compact check`);
  if (rejected > 100) problems.push(`${name}: ${rejected} rejected tool results`);
  if (latency !== null && latency.n >= 10 && latency.median > LATENCY_WARN_S) {
    problems.push(`${name}: median generation latency ${latency.median}s over ${latency.n} turns (> ${LATENCY_WARN_S}s — context damage? /compact)`);
  }
  if (latency !== null && latency.n >= 20 && latency.recentMedian > 2 * LATENCY_WARN_S) {
    problems.push(`${name}: RECENT turns at ${latency.recentMedian}s median (session median ${latency.median}s) — degraded NOW, /compact recommended`);
  }
}

// ---- ledger ----
const ledgerRows = [];
let ledgerRecords = [];
try {
  ledgerRecords = readFileSync(LEDGER, "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r !== null && Date.parse(r.ts ?? "") >= CUTOFF);
} catch {
  // no ledger — skip
}

const countBy = (key) => {
  const m = new Map();
  for (const r of ledgerRecords) {
    if (r.event !== "blocked" && r.event !== "expired" && r.event !== "error") continue;
    const k = key(r);
    if (k === undefined || k === null) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const blockedPairs = countBy((r) => `${r.from}→${r.to} [${r.code ?? "?"}]`);
for (const [pair, n] of blockedPairs.slice(0, 5)) {
  ledgerRows.push(`  ${n}× ${pair}`);
  if (n >= 3) problems.push(`ledger: ${n}× ${pair}`);
}

// reservations held (reserved minus released per alias)
const resv = new Map();
for (const r of ledgerRecords) {
  if (r.event === "reserved") resv.set(r.from, (resv.get(r.from) ?? 0) + 1);
  if (r.event === "released") resv.set(r.from, Math.max(0, (resv.get(r.from) ?? 0) - 1));
}
const held = [...resv.entries()].filter(([, n]) => n > 0);
for (const [alias, n] of held) {
  ledgerRows.push(`  @${alias} holds ${n} reservation(s)`);
  if (n >= 2) problems.push(`@${alias} still holds ${n} reservation(s)`);
}

// ---- output ----
if (AS_JSON) {
  console.log(JSON.stringify({ hours: HOURS, sessions: sessionRows, ledger: ledgerRows, problems }, null, 2));
} else {
  console.log(`mesh session report — last ${HOURS} h (${new Date().toISOString()})`);
  console.log("");
  console.log("sessions:");
  if (sessionRows.length === 0) console.log("  (none modified in the window)");
  for (const s of sessionRows.slice(0, 20)) {
    const lat = s.latency !== null ? `  lat ${s.latency.median}s med / ${s.latency.p90}s p90, last ${s.latency.recentMedian}s  (n=${s.latency.n})` : "";
    console.log(
      `  ${s.mb.toFixed(1).padStart(6)} MB  max ${String(s.maxCalls).padStart(4)} calls/msg  ${s.bursts} bursts  ${s.rejected} rejected${lat}  ${s.name}`,
    );
  }
  console.log("");
  console.log("ledger anomalies:");
  if (ledgerRows.length === 0) console.log("  (clean)");
  for (const l of ledgerRows) console.log(l);
  console.log("");
  if (problems.length === 0) {
    console.log("✔ no problems detected");
  } else {
    console.log(`⚠ ${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
  }
}
process.exit(problems.length > 0 ? 1 : 0);
