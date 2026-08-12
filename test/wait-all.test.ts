// test/wait-all.test.ts — D42: mesh_wait_all (group await with honest summary).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import type { MeshFrame } from "../src/protocol/envelope.js";
import { makeTempDirs, startTestBroker, waitFor, type TempDirs } from "./helpers.js";

describe("waitAll (D42)", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let lead: MeshClient;
  let bob: MeshClient;
  let carol: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-waitall-");
    broker = await startTestBroker(dirs.runtimeDir);
    lead = new MeshClient({ alias: "lead", runtimeDir: dirs.runtimeDir });
    bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir });
    carol = new MeshClient({ alias: "carol", runtimeDir: dirs.runtimeDir });
    await Promise.all([lead.connect(), bob.connect(), carol.connect()]);
  });

  after(async () => {
    await lead.close().catch(() => {});
    await bob.close().catch(() => {});
    await carol.close().catch(() => {});
    await broker.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it("waitAll with no awaited missions completes immediately with 0/0", async () => {
    lead.cancelAllAwaited(); // clear leftover pendings from previous tests
    const res = await lead.waitAll(1000);
    assert.equal(res.status, "complete");
    assert.equal(res.total, 0);
  });

  it("resolves 'complete' with every answer once all missions are answered", async () => {
    // bob + carol answer automatically on inbound msg
    bob.on("inbound", (f: MeshFrame) => {
      if (f.type === "msg") void bob.reply(f.id, `bob:${f.body ?? ""}`);
    });
    carol.on("inbound", (f: MeshFrame) => {
      if (f.type === "msg") void carol.reply(f.id, `carol:${f.body ?? ""}`);
    });
    // fire the missions WITHOUT awaiting them (waitAll does the waiting)
    const p1 = lead.send({ to: "bob", message: "M1", awaitReply: true, timeoutMs: 30_000 });
    const p2 = lead.send({ to: "carol", message: "M2", awaitReply: true, timeoutMs: 30_000 });
    void p1;
    void p2;
    const res = await lead.waitAll(8000);
    assert.equal(res.status, "complete");
    assert.equal(res.total, 2);
    assert.equal(res.answered, 2);
    assert.deepEqual(res.missing, []);
    const bodies = res.answers.map((a) => a.response);
    assert.ok(bodies.some((b) => b === "bob:M1"));
    assert.ok(bodies.some((b) => b === "carol:M2"));
  });

  it("times out and reports exactly who is missing", async () => {
    // clean the auto-answer handlers from the previous test: bob stays silent
    bob.removeAllListeners("inbound");
    carol.removeAllListeners("inbound");
    carol.on("inbound", (f: MeshFrame) => {
      if (f.type === "msg") void carol.reply(f.id, "carol done");
    });
    const p1 = lead.send({ to: "bob", message: "silent", awaitReply: true, timeoutMs: 30_000 });
    const p2 = lead.send({ to: "carol", message: "talk", awaitReply: true, timeoutMs: 30_000 });
    void p1;
    void p2;
    const res = await lead.waitAll(1500);
    assert.equal(res.status, "timeout");
    assert.equal(res.total, 2);
    assert.equal(res.answered, 1);
    assert.equal(res.missing.length, 1);
    assert.equal(res.missing[0]?.to, "bob");
    assert.ok(res.answers.some((a) => a.response === "carol done"));
  });

  it("missionStatus exposes the per-mission answer state", async () => {
    const status = lead.missionStatus();
    assert.ok(status.length >= 3);
    const silent = status.find((m) => m.to === "bob" && !m.answered);
    const done = status.find((m) => m.to === "carol" && m.answered);
    assert.ok(silent !== undefined, "bob mission tracked as waiting");
    assert.ok(done !== undefined, "carol mission tracked as answered");
  });
  it("missions blocked at ack are 'failed', never 'waiting' forever", async () => {
    const res = await lead.send({ to: "ghost-peer", message: "nobody home", awaitReply: true, timeoutMs: 500 });
    assert.equal(res.status, "blocked");
    const m = lead.missionStatus().find((x) => x.msgId === res.msgId);
    assert.ok(m, "mission tracked");
    assert.equal(m!.status, "failed");
    assert.equal(m!.answered, false);
  });

  it("missions that expire are 'expired', never 'waiting' forever", async () => {
    const res = await lead.send({ to: "bob", message: "silent mission", awaitReply: true, timeoutMs: 300 });
    assert.equal(res.status, "expired");
    const m = lead.missionStatus().find((x) => x.msgId === res.msgId);
    assert.ok(m, "mission tracked");
    assert.equal(m!.status, "expired");
  });

});


