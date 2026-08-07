// test/transcript.test.ts — 6 secret patterns redacted, UTF-8 32 KiB
// truncation, disabled no-op, enabled writes file, retention cleanup (§9.6).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  MeshTranscript,
  redactSecrets,
  SECRET_PATTERNS,
  TRANSCRIPT_MAX_BODY_BYTES,
  truncateUtf8,
} from "../src/extension/transcript.js";
import { buildFrame } from "../src/protocol/envelope.js";
import { makeTempDirs } from "./helpers.js";

describe("transcript: redaction patterns (6/6)", () => {
  it("private_key", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----";
    const out = redactSecrets(`key: ${pem} done`);
    assert.ok(!out.includes("MIIBOgIBAAJBAK"));
    assert.ok(out.includes("[REDACTED:PRIVATE_KEY]"));
  });

  it("bearer_token", () => {
    const out = redactSecrets("Authorization: Bearer abcdef1234567890.token-value");
    assert.ok(!out.includes("abcdef1234567890"));
    assert.ok(out.includes("[REDACTED:BEARER]"));
  });

  it("api_key (sk/ghp/github_pat/xox variants)", () => {
    for (const key of ["sk-abcdefghij123456", "ghp_abcdefghij123456", "github_pat_abcdefghij123456", "xoxb-123456789-abcdefgh"]) {
      const out = redactSecrets(`token=${key}`);
      assert.ok(!out.includes(key), key);
    }
    assert.ok(redactSecrets("sk-abcdefghij123456").includes("[REDACTED:API_KEY]"));
  });

  it("aws_access_key AKIA + 16", () => {
    const out = redactSecrets("aws: AKIAIOSFODNN7EXAMPLE ok");
    assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(out.includes("[REDACTED:AWS_ACCESS_KEY]"));
  });

  it("secret_assignment (SECRET/TOKEN/PASSWORD/API_KEY = value)", () => {
    const out = redactSecrets("MY_API_KEY=supersecretvalue123 and DB_PASSWORD=hunter2");
    assert.ok(!out.includes("supersecretvalue123"));
    assert.ok(!out.includes("hunter2"));
    assert.ok(out.includes("[REDACTED:SECRET_ASSIGNMENT]"));
  });

  it("email", () => {
    const out = redactSecrets("contact alice.dev@example.com please");
    assert.ok(!out.includes("alice.dev@example.com"));
    assert.ok(out.includes("[REDACTED:EMAIL]"));
  });

  it("exactly 6 patterns registered, plain text untouched", () => {
    assert.equal(SECRET_PATTERNS.length, 6);
    assert.equal(redactSecrets("hello mesh world"), "hello mesh world");
  });
});

describe("transcript: UTF-8 truncation at 32 KiB", () => {
  it("body > 32 KiB truncated without splitting a codepoint", () => {
    const body = "é".repeat(TRANSCRIPT_MAX_BODY_BYTES); // 2 bytes/char → 64 KiB
    const out = truncateUtf8(body);
    assert.ok(out.endsWith("…[truncated]"));
    const kept = out.slice(0, out.length - "…[truncated]".length);
    assert.ok(Buffer.byteLength(kept, "utf8") <= TRANSCRIPT_MAX_BODY_BYTES);
    assert.ok(!kept.includes("�")); // no replacement char — codepoints intact
  });

  it("short text passes through unchanged", () => {
    assert.equal(truncateUtf8("héllo"), "héllo");
  });
});

describe("transcript: opt-in behavior", () => {
  it("disabled → record is a no-op (no file)", (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const tr = new MeshTranscript(dirs.stateDir, false);
    tr.record("out", buildFrame({ type: "msg", from: "alice", to: "bob", body: "secret body" }));
    assert.equal(existsSync(path.join(dirs.stateDir, "transcripts")), false);
  });

  it("enabled → writes day file with REDACTED body", (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const tr = new MeshTranscript(dirs.stateDir, true);
    tr.record("out", buildFrame({ type: "msg", from: "alice", to: "bob", body: "mail me at bob@corp.io" }));
    const dir = path.join(dirs.stateDir, "transcripts");
    const dayFile = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    assert.ok(existsSync(dayFile));
    const entry = JSON.parse(readFileSync(dayFile, "utf8").trim()) as {
      dir: string;
      frame: { body?: string };
    };
    assert.equal(entry.dir, "out");
    assert.ok(entry.frame.body !== undefined);
    assert.ok(!entry.frame.body.includes("bob@corp.io"));
    assert.ok(entry.frame.body.includes("[REDACTED:EMAIL]"));
  });

  it("setEnabled toggles at runtime (/mesh log on|off)", (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const tr = new MeshTranscript(dirs.stateDir, false);
    assert.equal(tr.isEnabled(), false);
    tr.setEnabled(true);
    tr.record("in", buildFrame({ type: "msg", from: "bob", to: "alice", body: "hi" }));
    assert.ok(existsSync(path.join(dirs.stateDir, "transcripts")));
    tr.setEnabled(false);
    tr.record("in", buildFrame({ type: "msg", from: "bob", to: "alice", body: "again" }));
    const dayFile = path.join(dirs.stateDir, "transcripts", `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const lines = readFileSync(dayFile, "utf8").split("\n").filter((l) => l.trim() !== "");
    assert.equal(lines.length, 1); // only the enabled window recorded
  });

  it("retention: files older than retentionDays are deleted at startup", (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const dir = path.join(dirs.stateDir, "transcripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "2020-01-01.jsonl"), "{}\n", "utf8"); // ancient
    writeFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), "{}\n", "utf8"); // today
    writeFileSync(path.join(dir, "notes.txt"), "keep\n", "utf8"); // non-day file
    const tr = new MeshTranscript(dirs.stateDir, true, 7); // prunes in constructor
    assert.ok(tr.isEnabled());
    assert.equal(existsSync(path.join(dir, "2020-01-01.jsonl")), false);
    assert.equal(existsSync(path.join(dir, "notes.txt")), true);
    assert.equal(
      existsSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`)),
      true,
    );
  });
});
