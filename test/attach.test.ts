// test/attach.test.ts — D31: updateSessionName keeps the first user message.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateSessionName } from "../src/extension/attach.js";

function fakePi(initial?: string): {
  pi: { setSessionName(name: string): void; getSessionName(): string | undefined };
  names: string[];
} {
  let current: string | undefined = initial;
  const names: string[] = [];
  return {
    pi: {
      setSessionName: (name: string) => {
        names.push(name);
        current = name;
      },
      getSessionName: () => current,
    },
    names,
  };
}

function fakeRt(alias: string, rooms: string[], sessionFile?: string): never {
  return {
    client: { alias, rooms },
    ctx: sessionFile !== undefined ? { sessionManager: { getSessionFile: () => sessionFile } } : {},
  } as never;
}

function tmpSessionFile(lines: unknown[]): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mesh-sname-"));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("updateSessionName (D31): /resume shows identity + first message", () => {
  it("sets 'mesh @alias · rooms — first user message'", () => {
    const { file, cleanup } = tmpSessionFile([
      { type: "session", version: 3, id: "x", timestamp: "2026-08-11T00:00:00.000Z", cwd: "C:/x" },
      { type: "custom_message", customType: "mesh-context", content: "[mesh] you are...", display: false },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "analyse le shader" }] } },
      { type: "message", message: { role: "assistant", content: "ok" } },
    ]);
    try {
      const { pi, names } = fakePi(undefined);
      updateSessionName(pi as never, fakeRt("agent-1", ["cs-room"], file));
      assert.deepEqual(names, ["mesh @agent-1 · cs-room — analyse le shader"]);
    } finally {
      cleanup();
    }
  });

  it("skips mesh-context/mesh-inbound custom messages, takes the real first user text", () => {
    const { file, cleanup } = tmpSessionFile([
      { type: "session", version: 3, id: "x", timestamp: "2026-08-11T00:00:00.000Z", cwd: "C:/x" },
      { type: "custom_message", customType: "mesh-message", content: "[mesh] @agent-2 ...", display: true },
      { type: "message", message: { role: "user", content: "continues" } },
    ]);
    try {
      const { pi, names } = fakePi(undefined);
      updateSessionName(pi as never, fakeRt("main", ["voice"], file));
      assert.deepEqual(names, ["mesh @main · voice — continues"]);
    } finally {
      cleanup();
    }
  });

  it("long first messages are truncated", () => {
    const long = "x".repeat(500);
    const { file, cleanup } = tmpSessionFile([
      { type: "session", version: 3, id: "x", timestamp: "2026-08-11T00:00:00.000Z", cwd: "C:/x" },
      { type: "message", message: { role: "user", content: long } },
    ]);
    try {
      const { pi, names } = fakePi(undefined);
      updateSessionName(pi as never, fakeRt("a", ["r"], file));
      assert.ok(names[0]!.length < 150);
      assert.ok(names[0]!.endsWith("…"));
    } finally {
      cleanup();
    }
  });

  it("no user message yet → identity only", () => {
    const { file, cleanup } = tmpSessionFile([
      { type: "session", version: 3, id: "x", timestamp: "2026-08-11T00:00:00.000Z", cwd: "C:/x" },
    ]);
    try {
      const { pi, names } = fakePi(undefined);
      updateSessionName(pi as never, fakeRt("main", [], file));
      assert.deepEqual(names, ["mesh @main"]);
    } finally {
      cleanup();
    }
  });

  it("refreshes existing mesh names; never overwrites user names", () => {
    const { pi, names } = fakePi("mesh @agent-1 · cs-room");
    updateSessionName(pi as never, fakeRt("agent-1", ["cs-room", "voice"]));
    assert.deepEqual(names, ["mesh @agent-1 · cs-room,voice"]);

    const { pi: pi2, names: names2 } = fakePi("my session");
    updateSessionName(pi2 as never, fakeRt("agent-1", ["cs-room"]));
    assert.deepEqual(names2, []);
  });
});
