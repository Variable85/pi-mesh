// test/mailbox.test.ts — E5 (queued_offline + delivery at hello + body intact),
// E6 (cap drop oldest), TTL expiry, delivery order (D9, §7.7).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  brokerSocketPathOf,
  makeTempDirs,
  RawClient,
  startTestBroker,
  sleep,
  type TempDirs,
} from "./helpers.js";
import type { RunningBroker } from "../src/broker/broker.js";

async function setup(
  t: { after: (fn: () => void | Promise<void>) => void },
  overrides: Parameters<typeof startTestBroker>[1] = {},
): Promise<{ dirs: TempDirs; broker: RunningBroker; sock: string }> {
  const dirs = makeTempDirs();
  t.after(() => dirs.cleanup());
  const broker = await startTestBroker(dirs.runtimeDir, overrides);
  t.after(async () => {
    await broker.close();
  });
  return { dirs, broker, sock: brokerSocketPathOf(dirs.runtimeDir) };
}

describe("mailbox: offline queue", () => {
  it("E5: known offline alias → queued_offline + mailbox delivery at next hello, body intact", async (t) => {
    const { broker, sock } = await setup(t);
    const alice = await RawClient.connect(sock);
    t.after(() => alice.close());
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");

    // bob comes online once (becomes a known alias), then disconnects
    const bob1 = await RawClient.connect(sock);
    bob1.hello("bob");
    await bob1.waitFrame((f) => f.type === "welcome");
    bob1.close();
    await sleep(150); // broker observes the close

    alice.send({ type: "msg", from: "alice", to: "bob", body: "while-you-were-out" });
    const ack = await alice.waitFrame((f) => f.type === "ack");
    assert.equal(ack.status, "queued_offline");

    const bob2 = await RawClient.connect(sock);
    t.after(() => bob2.close());
    bob2.hello("bob");
    const welcome = await bob2.waitFrame((f) => f.type === "welcome");
    assert.equal(welcome.mailboxCount, 1);
    const mf = await bob2.waitFrame((f) => f.type === "mailbox");
    assert.equal(mf.body, "while-you-were-out"); // body intact
    assert.equal(mf.from, "alice");
    assert.ok(typeof mf.queuedAt === "string");
    assert.equal(broker.state.stats.mailboxDelivered, 1);
  });

  it("E6: mailbox cap 3, send 5 → oldest dropped, 3 delivered at hello", async (t) => {
    const { broker, sock } = await setup(t, { config: { mailboxCap: 3 } });
    const alice = await RawClient.connect(sock);
    t.after(() => alice.close());
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob1 = await RawClient.connect(sock);
    bob1.hello("bob");
    await bob1.waitFrame((f) => f.type === "welcome");
    bob1.close();
    await sleep(150);

    for (let i = 0; i < 5; i += 1) {
      alice.send({ type: "msg", from: "alice", to: "bob", body: `m${i}` });
    }
    const acks = await alice.waitFrames((f) => f.type === "ack", 5);
    assert.ok(acks.every((a) => a.status === "queued_offline")); // still acked (E6)
    assert.equal(broker.state.stats.mailboxDropped, 2); // drop-oldest counter

    const bob2 = await RawClient.connect(sock);
    t.after(() => bob2.close());
    bob2.hello("bob");
    const welcome = await bob2.waitFrame((f) => f.type === "welcome");
    assert.equal(welcome.mailboxCount, 3);
    const mfs = await bob2.waitFrames((f) => f.type === "mailbox", 3);
    assert.deepEqual(
      mfs.map((f) => f.body),
      ["m2", "m3", "m4"], // oldest dropped, ORDER PRESERVED
    );
  });

  it("TTL: expired mailbox entries are not delivered", async (t) => {
    const { sock } = await setup(t, { config: { mailboxTtlMs: 200 } });
    const alice = await RawClient.connect(sock);
    t.after(() => alice.close());
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob1 = await RawClient.connect(sock);
    bob1.hello("bob");
    await bob1.waitFrame((f) => f.type === "welcome");
    bob1.close();
    await sleep(150);

    alice.send({ type: "msg", from: "alice", to: "bob", body: "stale" });
    const ack = await alice.waitFrame((f) => f.type === "ack");
    assert.equal(ack.status, "queued_offline");

    await sleep(400); // beyond TTL (200 ms)
    const bob2 = await RawClient.connect(sock);
    t.after(() => bob2.close());
    bob2.hello("bob");
    const welcome = await bob2.waitFrame((f) => f.type === "welcome");
    assert.equal(welcome.mailboxCount, 0);
    // allow a beat for any stray mailbox frame — none must arrive
    await sleep(150);
    assert.equal(bob2.frames.filter((f) => f.type === "mailbox").length, 0);
  });

  it("order preserved across multiple offline senders", async (t) => {
    const { sock } = await setup(t);
    const alice = await RawClient.connect(sock);
    t.after(() => alice.close());
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const carol = await RawClient.connect(sock);
    t.after(() => carol.close());
    carol.hello("carol");
    await carol.waitFrame((f) => f.type === "welcome");
    const bob1 = await RawClient.connect(sock);
    bob1.hello("bob");
    await bob1.waitFrame((f) => f.type === "welcome");
    bob1.close();
    await sleep(150);

    alice.send({ type: "msg", from: "alice", to: "bob", body: "a1" });
    carol.send({ type: "msg", from: "carol", to: "bob", body: "c1" });
    alice.send({ type: "msg", from: "alice", to: "bob", body: "a2" });
    await alice.waitFrames((f) => f.type === "ack", 2);
    await carol.waitFrames((f) => f.type === "ack", 1);

    const bob2 = await RawClient.connect(sock);
    t.after(() => bob2.close());
    bob2.hello("bob");
    const mfs = await bob2.waitFrames((f) => f.type === "mailbox", 3);
    const bodies = mfs.map((f) => f.body);
    // cross-sender arrival order at the broker is not deterministic; what the
    // mailbox guarantees is per-sender FIFO + no loss.
    assert.deepEqual([...bodies].sort(), ["a1", "a2", "c1"]);
    assert.ok(bodies.indexOf("a1") < bodies.indexOf("a2"), "per-sender order preserved");
  });
});
