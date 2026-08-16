// test/tools-send.test.ts — A8 regression: mesh_send ledger records must store
// the CANONICAL alias. A model calling mesh_send with to='@Bob' must produce
// 'sent' (and post-ack) records with to='bob' (and details.to='bob'), so
// ledger predicates are insensitive to how the alias was typed. The user-facing
// result text stays unchanged. Stubs follow the tools-reply.test.ts pattern.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MeshLedger, type LedgerRecord } from "../src/extension/ledger.js";
import type { ExtensionAPI, SessionContext, ToolDefinition } from "../src/extension/pi-types.js";
import { registerTools, type MeshRuntime } from "../src/extension/tools.js";
import type { SendResult } from "../src/client/client.js";
import { makeTempDirs } from "./helpers.js";

function makeRuntime(stateDir: string, sendResult: SendResult, rooms: string[] = ["default"]): { rt: MeshRuntime; ledger: MeshLedger } {
  const ledger = new MeshLedger(stateDir);
  const rt = {
    client: {
      alias: "alice",
      rooms,
      isOnline: () => true,
      send: () => Promise.resolve(sendResult),
      connect: () => Promise.reject(new Error("must not connect in these tests")),
      // M1 send-guard surface
      knowsPeer: () => true,
      knownPeerList: ["bob"],
      busyForMs: () => undefined,
    },
    ledger,
    transcript: { isEnabled: () => false, record: () => {} },
    guards: { checkSend: () => ({ ok: true, warnings: [] }) },
    ctx: null,
    stateDir,
    runtimeDir: stateDir,
    startedAt: Date.now(),
    ledgerFailures: 0,
    transcriptFailures: 0,
    injectionFailures: 0,
  } as unknown as MeshRuntime;
  return { rt, ledger };
}

function toolRuntime(rt: MeshRuntime): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerTools(pi, () => rt);
  return tools;
}

function ledgerRecords(ledger: MeshLedger): LedgerRecord[] {
  return readFileSync(ledger.path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LedgerRecord);
}

describe("mesh_send ledger canonical alias (A8)", () => {
  it("to='@Bob' → every ledger record stores to='bob' (+ details mirror), text unchanged", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const { rt, ledger } = makeRuntime(dirs.stateDir, { status: "delivered", msgId: "m_s_11111111" });
    const tools = toolRuntime(rt);
    const tool = tools.get("mesh_send");
    assert.ok(tool, "mesh_send tool registered");

    const res = await tool.execute(
      "tc1",
      { to: "@Bob", message: "hello bob" },
      undefined,
      undefined,
      {} as unknown as SessionContext,
    );
    // user-facing result text unchanged
    assert.equal(res.content[0]!.text, "delivered m_s_11111111");

    const recs = ledgerRecords(ledger);
    assert.deepEqual(recs.map((r) => r.event), ["sent", "delivered"]);
    for (const rec of recs) {
      assert.equal(rec.to, "bob", `ledger '${rec.event}' record must store the canonical alias`);
      assert.equal(rec.from, "alice");
      assert.equal(rec.bodyStored, false);
    }
    // details mirror the canonical alias
    assert.equal(res.details?.to, "bob");
    assert.equal(res.details?.status, "delivered");
  });

  it("no room param → resolves to the first joined room when 'default' was left", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    // session in cs-room ONLY (left 'default') — sends must NOT default to
    // "default" (the broker would refuse not_member).
    const { rt, ledger } = makeRuntime(dirs.stateDir, { status: "delivered", msgId: "m_s_22222222" }, ["cs-room"]);
    const tools = toolRuntime(rt);
    const tool = tools.get("mesh_send");
    assert.ok(tool, "mesh_send tool registered");

    const res = await tool.execute(
      "tc2",
      { to: "bob", message: "hello cs" },
      undefined,
      undefined,
      {} as unknown as SessionContext,
    );
    assert.equal(res.content[0]!.text, "delivered m_s_22222222");
    const recs = ledgerRecords(ledger);
    assert.equal(recs[0]?.room, "cs-room", "ledger 'sent' must record the resolved room");
    assert.equal(recs[1]?.room, "cs-room", "ledger 'delivered' must record the resolved room");
    assert.equal(res.details?.room, "cs-room");
  });

  it("explicit room param still wins over the joined rooms", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const { rt, ledger } = makeRuntime(dirs.stateDir, { status: "delivered", msgId: "m_s_33333333" }, ["cs-room"]);
    const tools = toolRuntime(rt);
    const tool = tools.get("mesh_send");
    assert.ok(tool, "mesh_send tool registered");

    const res = await tool.execute(
      "tc3",
      { to: "bob", message: "explicit", room: "ops" },
      undefined,
      undefined,
      {} as unknown as SessionContext,
    );
    assert.equal(res.content[0]!.text, "delivered m_s_33333333");
    const recs = ledgerRecords(ledger);
    assert.equal(recs[0]?.room, "ops");
  });
});
