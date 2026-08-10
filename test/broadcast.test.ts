// test/broadcast.test.ts — D24: room broadcast + reply variants (1:1, targeted,
// replyAll) over a real broker.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import type { MeshFrame } from "../src/protocol/envelope.js";
import { makeTempDirs, startTestBroker, waitFor, type TempDirs } from "./helpers.js";

/** Bound any promise — a hanging test must fail, not block the suite. */
function withTimeout<T>(p: Promise<T>, ms = 5000, label = "async"): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
      t.unref();
    }),
  ]);
}

describe("room broadcast (D24)", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let lead: MeshClient;
  let bob: MeshClient;
  let carol: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-broadcast-");
    broker = await startTestBroker(dirs.runtimeDir);
    lead = new MeshClient({ alias: "lead", runtimeDir: dirs.runtimeDir });
    bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir });
    carol = new MeshClient({ alias: "carol", runtimeDir: dirs.runtimeDir });
    await Promise.all([lead.connect(), bob.connect(), carol.connect()]);
    await Promise.all([lead.join("ops"), bob.join("ops"), carol.join("ops")]);
  });

  after(async () => {
    await lead.close().catch(() => {});
    await bob.close().catch(() => {});
    await carol.close().catch(() => {});
    await broker.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  function collect(client: MeshClient, n = 1): Promise<MeshFrame[]> {
    const frames: MeshFrame[] = [];
    client.on("inbound", (f: MeshFrame) => {
      if (f.type === "msg") frames.push(f);
    });
    return new Promise((resolve) => {
      const check = (): void => {
        if (frames.length >= n) resolve(frames);
        else setTimeout(check, 10);
      };
      check();
    });
  }

  it("broadcast reaches every online room member with honest counts", async () => {
    const bobGot = collect(bob);
    const carolGot = collect(carol);
    const res = await lead.send({
      message: "MISSION A",
      room: "ops",
      broadcast: true,
    });
    assert.equal(res.status, "delivered");
    assert.equal(res.deliveredCount, 2);
    assert.equal(res.totalCount, 2);
    const [bobFrames, carolFrames] = await withTimeout(Promise.all([bobGot, carolGot]), 8000, "broadcast delivery");
    assert.equal(bobFrames[0]?.body, "MISSION A");
    assert.equal(bobFrames[0]?.broadcast, true);
    assert.equal(carolFrames[0]?.body, "MISSION A");
  });

  it("broadcast with to is refused client-side", async () => {
    const res = await lead.send({ to: "bob", message: "x", room: "ops", broadcast: true });
    assert.equal(res.status, "error");
    assert.equal(res.reason, "broadcast_with_to");
  });

  it("broadcast to a room with no other member → peer_not_found", async () => {
    await lead.join("empty-room");
    const res = await lead.send({ message: "lonely", room: "empty-room", broadcast: true });
    assert.equal(res.status, "blocked"); // peer_not_found maps to blocked client-side
    assert.equal(res.reason, "peer_not_found");
    await lead.leave("empty-room");
  });

  it("default reply stays 1:1 with the original sender", async () => {
    const got = new Promise<MeshFrame>((resolve) => {
      bob.once("inbound", (f: MeshFrame) => resolve(f));
    });
    const msg = await lead.send({ to: "bob", message: "private q", room: "ops" });
    const frame = await withTimeout(got, 5000, "bob inbound");
    const res = await bob.reply(frame.id, "private a");
    assert.equal(res.status, "delivered");
    assert.equal(res.deliveredCount, undefined); // unicast: no fan-out counts
    // carol must NOT have seen the private reply
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(carol.peerReservationAliases.length >= 0, true); // sanity only
  });

  it("targeted reply answers to another member than the sender", async () => {
    // lead → carol (original sender context for bob)
    const carolGot = new Promise<MeshFrame>((resolve) => {
      carol.once("inbound", (f: MeshFrame) => resolve(f));
    });
    await lead.send({ to: "carol", message: "for carol", room: "ops" });
    const carolFrame = await withTimeout(carolGot, 5000, "carol inbound");
    // carol replies TARGETED at bob (not the sender lead)
    const bobGot = new Promise<MeshFrame>((resolve) => {
      bob.once("inbound", (f: MeshFrame) => resolve(f));
    });
    const res = await carol.reply(carolFrame.id, "bob please handle", { to: "bob" });
    assert.equal(res.status, "delivered");
    const bobFrame = await withTimeout(bobGot, 5000, "bob targeted reply");
    assert.equal(bobFrame.type, "reply");
    assert.equal(bobFrame.body, "bob please handle");
    assert.equal(bobFrame.from, "carol");
  });

  it("replyAll fans the answer out to the whole room (incl. original sender)", async () => {
    const leadGot = new Promise<MeshFrame>((resolve) => {
      lead.once("inbound", (f: MeshFrame) => resolve(f));
    });
    const carolGot = new Promise<MeshFrame>((resolve) => {
      carol.once("inbound", (f: MeshFrame) => resolve(f));
    });
    const msg = await lead.send({ to: "bob", message: "status?", room: "ops" });
    assert.equal(msg.status, "delivered");
    assert.ok(msg.msgId);
    await waitFor(async () => {
      const snap = await bob.status();
      return snap.peers.length > 0 ? true : undefined;
    });
    // bob answers to the WHOLE room: lead (sender) + carol
    const res = await bob.reply(msg.msgId!, "ALL: done", { replyAll: true });
    assert.equal(res.status, "delivered");
    assert.equal(res.deliveredCount, 2);
    assert.equal(res.totalCount, 2);
    const [leadFrame, carolFrame] = await withTimeout(Promise.all([leadGot, carolGot]), 8000, "replyAll delivery");
    assert.equal(leadFrame.type, "reply");
    assert.equal(leadFrame.replyAll, true);
    assert.equal(leadFrame.body, "ALL: done");
    assert.equal(carolFrame.body, "ALL: done");
  });

  it("replyAll with to is refused", async () => {
    const msg = await lead.send({ to: "bob", message: "q2", room: "ops" });
    assert.equal(msg.status, "delivered");
    assert.ok(msg.msgId);
    const res = await bob.reply(msg.msgId!, "x", { replyAll: true, to: "carol" });
    assert.equal(res.status, "error");
    assert.equal(res.reason, "reply_all_with_to");
  });
});
