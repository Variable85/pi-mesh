// test/ledger.test.ts — hash-only proof: every written line parses,
// bodyStored:false, no forbidden key; E25 fail-closed (zero bytes); rotation.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { MeshLedger, type LedgerInput } from "../src/extension/ledger.js";
import { hasForbiddenPersistedKey } from "../src/protocol/envelope.js";
import { LEDGER_FILE_NAME } from "../src/shared/paths.js";
import { makeTempDirs } from "./helpers.js";

const FORBIDDEN_KEY_RE = /"(body|task|prompt|output|content|message|rationale|text|diff|patch)":/;

describe("ledger: hash-only guarantees (I1)", () => {
  it("every written line parses, has schema+bodyStored:false, no forbidden key", (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const ledger = new MeshLedger(dirs.stateDir);
    ledger.append({ event: "sent", id: "m_a_11111111", from: "alice", to: "bob", room: "default", priority: "normal", bodyHash: "ab12" });
    ledger.append({ event: "delivered", id: "m_a_11111111", from: "alice", to: "bob", bodyHash: "ab12" });
    ledger.append({ event: "queued_offline", id: "m_b_22222222", from: "alice", to: "bob" });
    ledger.append({ event: "blocked", from: "alice", to: "alice", code: "self_send" });
    ledger.append({ event: "inbound", id: "m_c_33333333", from: "bob", to: "alice", refs: ["src/a.ts"] });

    const text = readFileSync(ledger.path, "utf8");
    assert.equal(FORBIDDEN_KEY_RE.test(text), false, "raw file text carries a forbidden key");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 5);
    for (const line of lines) {
      const rec: unknown = JSON.parse(line); // every line parses
      assert.equal(hasForbiddenPersistedKey(rec), false);
      const r = rec as Record<string, unknown>;
      assert.equal(r.schema, "mesh.ledger.v1");
      assert.equal(r.bodyStored, false);
      assert.equal(typeof r.ts, "string");
    }
  });

  it("E25: nested forbidden key → throws fail-closed, ZERO bytes appended", (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const ledger = new MeshLedger(dirs.stateDir);
    const poisoned = {
      event: "sent",
      from: "alice",
      to: "bob",
      details: { nested: [{ body: "leak" }] },
    } as unknown as LedgerInput;
    assert.throws(() => ledger.append(poisoned), /fail-closed/);
    assert.equal(existsSync(ledger.path), false, "no file may be created on refusal");

    // a clean append still works afterwards
    ledger.append({ event: "sent", from: "alice", to: "bob" });
    const lines = readFileSync(ledger.path, "utf8").split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 1);
    assert.equal(FORBIDDEN_KEY_RE.test(lines[0]!), false);
  });

  it("rotation: > maxBytes → ledger-<date>.jsonl.1 + fresh ledger", (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const ledger = new MeshLedger(dirs.stateDir, 300); // tiny cap for the test
    for (let i = 0; i < 12; i += 1) {
      ledger.append({ event: "sent", id: `m_r_${String(i).padStart(8, "0")}`, from: "alice", to: "bob", bodyHash: "x".repeat(64) });
    }
    const files = readdirSync(dirs.stateDir);
    const rotated = files.filter((f) => /^ledger-\d{4}-\d{2}-\d{2}\.jsonl\.\d+$/.test(f));
    assert.ok(rotated.length >= 1, `rotated files: ${files.join(",")}`);
    assert.ok(existsSync(path.join(dirs.stateDir, LEDGER_FILE_NAME)), "fresh ledger exists");
    // all 12 records survived across fresh + rotated files, all valid hash-only jsonl
    let totalLines = 0;
    for (const f of [LEDGER_FILE_NAME, ...rotated]) {
      const text = readFileSync(path.join(dirs.stateDir, f), "utf8");
      assert.equal(FORBIDDEN_KEY_RE.test(text), false, `forbidden key in ${f}`);
      for (const line of text.split("\n").filter((l) => l.trim() !== "")) {
        assert.equal(hasForbiddenPersistedKey(JSON.parse(line)), false);
        totalLines += 1;
      }
    }
    assert.equal(totalLines, 12);
  });
});
