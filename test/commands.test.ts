// test/commands.test.ts — /mesh join parsing (D22): `join <room> as <alias>`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJoinArgs } from "../src/extension/commands.js";

describe("parseJoinArgs", () => {
  it("plain room", () => {
    assert.deepEqual(parseJoinArgs(["ops"]), { room: "ops", observer: false });
  });

  it("room + observer", () => {
    assert.deepEqual(parseJoinArgs(["ops", "observer"]), { room: "ops", observer: true });
  });

  it("room as alias", () => {
    assert.deepEqual(parseJoinArgs(["ops", "as", "agent-1"]), {
      room: "ops",
      asAlias: "agent-1",
      observer: false,
    });
  });

  it("room as alias observer", () => {
    assert.deepEqual(parseJoinArgs(["ops", "as", "agent-1", "observer"]), {
      room: "ops",
      asAlias: "agent-1",
      observer: true,
    });
  });

  it("as alias without room (alias-only)", () => {
    assert.deepEqual(parseJoinArgs(["as", "agent-1"]), {
      asAlias: "agent-1",
      observer: false,
    });
  });

  it("no args", () => {
    assert.deepEqual(parseJoinArgs([]), { room: undefined, observer: false });
  });
});
