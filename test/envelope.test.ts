// test/envelope.test.ts — every §6.2 rule (valid + invalid), forbidden keys,
// buildFrame/parseFrameLine roundtrip, E22 refs, E13 validation-level.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFrame,
  hasForbiddenPersistedKey,
  isValidAlias,
  isValidRefPath,
  isValidRoom,
  normalizeAlias,
  parseFrameLine,
  validateFrame,
} from "../src/protocol/envelope.js";
import { sha256 } from "../src/protocol/frames.js";
import { MAX_BODY_BYTES } from "../src/shared/config.js";

describe("envelope: rule 1 — v/type/id/ts", () => {
  it("accepts a valid msg frame", () => {
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body: "hi" });
    const res = validateFrame(JSON.parse(JSON.stringify(f)));
    assert.equal(res.ok, true);
  });

  it("rejects v !== 1", () => {
    const f = { ...buildFrame({ type: "ping", from: "alice" }), v: 2 };
    const res = validateFrame(f);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "invalid_frame");
  });

  it("rejects unknown type", () => {
    const f = { ...buildFrame({ type: "ping", from: "alice" }), type: "nope" };
    const res = validateFrame(f);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "invalid_frame");
  });

  it("rejects empty id and id > 64 chars", () => {
    const base = buildFrame({ type: "ping", from: "alice" });
    assert.equal(validateFrame({ ...base, id: "" }).ok, false);
    assert.equal(validateFrame({ ...base, id: "x".repeat(65) }).ok, false);
  });

  it("rejects bad ts", () => {
    const base = buildFrame({ type: "ping", from: "alice" });
    assert.equal(validateFrame({ ...base, ts: "not-a-date" }).ok, false);
    assert.equal(validateFrame({ ...base, ts: 123 }).ok, false);
  });

  it("tolerates unknown extra keys (forward/backward tolerance)", () => {
    const f = { ...buildFrame({ type: "ping", from: "alice" }), futureField: { x: 1 } };
    assert.equal(validateFrame(f).ok, true);
  });
});

describe("envelope: N1 — strict ISO-8601 timestamps", () => {
  const base = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(buildFrame({ type: "ping", from: "alice" }))) as Record<
      string,
      unknown
    >;

  it("rejects loose date strings that Date.parse accepts", () => {
    assert.equal(validateFrame({ ...base(), ts: "2024" }).ok, false);
    assert.equal(validateFrame({ ...base(), ts: "March 5 2024" }).ok, false);
  });

  it("accepts strict ISO-8601 shapes", () => {
    assert.equal(validateFrame({ ...base(), ts: "2026-07-13T14:05:00.000Z" }).ok, true);
    assert.equal(validateFrame({ ...base(), ts: "2026-07-13T14:05:00Z" }).ok, true);
    assert.equal(validateFrame({ ...base(), ts: "2026-07-13T14:05:00+02:00" }).ok, true);
  });

  it("rejects ISO-shaped but invalid dates (Date.parse NaN)", () => {
    assert.equal(validateFrame({ ...base(), ts: "2026-13-40T25:99:99Z" }).ok, false);
  });
});

describe("envelope: rule 2/3 — alias & room", () => {
  it("alias regex: valid and invalid", () => {
    assert.equal(isValidAlias("alice"), true);
    assert.equal(isValidAlias("worker-3"), true);
    assert.equal(isValidAlias("a1"), true);
    assert.equal(isValidAlias("Alice"), false); // uppercase (normalized before validation)
    assert.equal(isValidAlias("bad_alias"), false); // underscore refused (D4)
    assert.equal(isValidAlias("1abc"), false);
    assert.equal(isValidAlias("a"), false); // min 2 chars
    assert.equal(isValidAlias("a".repeat(33)), false);
  });

  it("normalizeAlias trims, strips @, lowercases (E12)", () => {
    assert.equal(normalizeAlias("  @Alice  "), "alice");
    assert.equal(normalizeAlias("BOB"), "bob");
  });

  it("rejects frame with non-normalized alias", () => {
    const res = validateFrame({ ...buildFrame({ type: "msg", from: "alice", to: "bob", body: "x" }), from: "Alice" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "invalid_alias");
  });

  it("room regex", () => {
    assert.equal(isValidRoom("default"), true);
    assert.equal(isValidRoom("ops.eu-west"), true);
    assert.equal(isValidRoom("0room"), true);
    assert.equal(isValidRoom("-bad"), false);
    assert.equal(isValidRoom("bad_room"), false);
    assert.equal(isValidRoom("x".repeat(65)), false);
  });

  it("rejects bad room in frame", () => {
    const res = validateFrame({ ...buildFrame({ type: "msg", from: "alice", to: "bob", body: "x" }), room: "bad_room" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "invalid_room");
  });
});

describe("envelope: rule 4 — body & hash", () => {
  it("rejects body > 32 KiB (E10 validation level)", () => {
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body: big });
    const res = validateFrame(JSON.parse(JSON.stringify(f)));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "invalid_frame");
  });

  it("accepts body exactly 32 KiB", () => {
    const body = "x".repeat(MAX_BODY_BYTES);
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body });
    assert.equal(validateFrame(JSON.parse(JSON.stringify(f))).ok, true);
  });

  it("rejects bodyHash mismatch (E21 validation level)", () => {
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body: "hello" });
    f.bodyHash = sha256("different");
    const res = validateFrame(JSON.parse(JSON.stringify(f)));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "hash_mismatch");
  });

  it("rejects bodyHash without body", () => {
    const f = { ...buildFrame({ type: "ping", from: "alice" }), bodyHash: sha256("x") };
    assert.equal(validateFrame(f).ok, false);
  });
});

describe("envelope: rule 5 — force requires reasonHash (E13 validation level)", () => {
  it("force without reasonHash → force_requires_reason", () => {
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body: "stop", priority: "force" });
    const res = validateFrame(JSON.parse(JSON.stringify(f)));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "force_requires_reason");
  });

  it("force with valid reasonHash passes", () => {
    const f = buildFrame({
      type: "msg", from: "lead", to: "bob", body: "stop", priority: "force", reasonHash: sha256("r"),
    });
    assert.equal(validateFrame(JSON.parse(JSON.stringify(f))).ok, true);
  });

  it("non-force with malformed reasonHash rejected", () => {
    const f = { ...buildFrame({ type: "msg", from: "alice", to: "bob", body: "x" }), reasonHash: "zz" };
    assert.equal(validateFrame(f).ok, false);
  });
});

describe("envelope: rule 6 — reply/remind require replyTo", () => {
  it("reply without replyTo → reply_without_target", () => {
    const f = buildFrame({ type: "reply", from: "bob", to: "alice", body: "x" });
    const res = validateFrame(JSON.parse(JSON.stringify(f)));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "reply_without_target");
  });

  it("remind without replyTo → reply_without_target", () => {
    const f = buildFrame({ type: "remind", from: "alice", to: "bob" });
    const res = validateFrame(JSON.parse(JSON.stringify(f)));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "reply_without_target");
  });

  it("reply with replyTo passes", () => {
    const f = buildFrame({ type: "reply", from: "bob", to: "alice", replyTo: "m_abc_12345678", body: "x" });
    assert.equal(validateFrame(JSON.parse(JSON.stringify(f))).ok, true);
  });
});

describe("envelope: rule 7 — refs (E22)", () => {
  it("accepts repo-relative refs", () => {
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body: "x", refs: ["src/a.ts", "docs/plan.md"] });
    assert.equal(validateFrame(JSON.parse(JSON.stringify(f))).ok, true);
  });

  it("rejects .., absolute, backslash, .env", () => {
    assert.equal(isValidRefPath("../secret"), false);
    assert.equal(isValidRefPath("a/../b"), false);
    assert.equal(isValidRefPath("/etc/passwd"), false);
    assert.equal(isValidRefPath("a\\b"), false);
    assert.equal(isValidRefPath(".env"), false);
    assert.equal(isValidRefPath("dir/.env"), false);
    assert.equal(isValidRefPath(".env.local"), false);
    assert.equal(isValidRefPath("src/ok.ts"), true);
  });

  it("rejects frame carrying invalid refs", () => {
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body: "x", refs: ["../escape"] });
    assert.equal(validateFrame(JSON.parse(JSON.stringify(f))).ok, false);
  });

  it("rejects more than 8 refs", () => {
    const refs = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body: "x", refs });
    assert.equal(validateFrame(JSON.parse(JSON.stringify(f))).ok, false);
  });
});

describe("envelope: error frames & enums", () => {
  it("error with closed-set code passes", () => {
    const f = buildFrame({ type: "error", code: "peer_not_found" });
    assert.equal(validateFrame(JSON.parse(JSON.stringify(f))).ok, true);
  });

  it("error with unknown code rejected", () => {
    const f = { ...buildFrame({ type: "error" }), code: "weird_code" };
    assert.equal(validateFrame(f).ok, false);
  });

  it("bad priority / role rejected", () => {
    const base = buildFrame({ type: "msg", from: "alice", to: "bob", body: "x" });
    assert.equal(validateFrame({ ...base, priority: "panic" }).ok, false);
    assert.equal(validateFrame({ ...base, role: "king" }).ok, false);
  });

  it("bad expiresAt rejected", () => {
    const base = buildFrame({ type: "msg", from: "alice", to: "bob", body: "x" });
    assert.equal(validateFrame({ ...base, expiresAt: "soon" }).ok, false);
  });
});

describe("envelope: buildFrame / parseFrameLine roundtrip", () => {
  it("roundtrips a full msg frame", () => {
    const f = buildFrame({
      type: "msg", from: "alice", to: "bob", room: "ops", priority: "urgent",
      body: "héllo ✓", refs: ["src/a.ts"], expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    const res = parseFrameLine(JSON.stringify(f));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.frame.id, f.id);
      assert.equal(res.frame.body, "héllo ✓");
      assert.equal(res.frame.bodyHash, f.bodyHash);
      assert.equal(res.frame.priority, "urgent");
    }
  });

  it("parseFrameLine rejects non-JSON", () => {
    const res = parseFrameLine("not json{");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "invalid_frame");
  });

  it("buildFrame auto-computes bodyHash = sha256(body)", () => {
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body: "abc" });
    assert.equal(f.bodyHash, sha256("abc"));
  });
});

describe("envelope: forbidden persisted keys (ledger safety, E25 primitive)", () => {
  it("detects top-level forbidden keys", () => {
    for (const key of ["body", "task", "prompt", "output", "content", "message", "rationale", "text", "diff", "patch"]) {
      assert.equal(hasForbiddenPersistedKey({ [key]: "x" }), true, key);
    }
  });

  it("detects nested forbidden keys (recursive)", () => {
    assert.equal(hasForbiddenPersistedKey({ a: { b: [{ content: "x" }] } }), true);
    assert.equal(hasForbiddenPersistedKey({ event: "sent", details: { body: "x" } }), true);
  });

  it("passes clean records (bodyHash is NOT forbidden)", () => {
    assert.equal(hasForbiddenPersistedKey({ schema: "mesh.ledger.v1", event: "sent", bodyHash: "ab", bodyStored: false }), false);
    assert.equal(hasForbiddenPersistedKey(null), false);
    assert.equal(hasForbiddenPersistedKey("body"), false);
    assert.equal(hasForbiddenPersistedKey([1, 2, { ok: true }]), false);
  });
});

describe("envelope: ack status closed set", () => {
  it("every ACK_STATUSES value validates on an ack frame", () => {
    for (const status of ["delivered", "queued_offline", "dropped_offline", "ok"]) {
      const res = validateFrame(buildFrame({ type: "ack", id: "m_x", status }));
      assert.equal(res.ok, true, status);
    }
  });

  it("a statusless ack stays valid (status optional)", () => {
    const res = validateFrame(buildFrame({ type: "ack", id: "m_x" }));
    assert.equal(res.ok, true);
  });

  it("unknown ack status is rejected", () => {
    const res = validateFrame(buildFrame({ type: "ack", id: "m_x", status: "probably" }));
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "invalid_frame");
  });

  it("status on a NON-ack frame is not constrained by the ack set", () => {
    const res = validateFrame(buildFrame({ type: "activity", from: "alice", status: "busy" }));
    assert.equal(res.ok, true);
  });
});
