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
    const acks = await alice.waitFrames((f) => f.type === "ack", 7); // 5 queued + 2 drop notices
    const queued = acks.filter((a) => a.status === "queued_offline");
    const notices = acks.filter((a) => a.status === "dropped_offline");
    assert.equal(queued.length, 5); // still acked (E6)
    assert.equal(notices.length, 2); // evicted senders are TOLD (honest drops)
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

describe("mailbox: honest drop notices (sender learns a queued message was dropped)", () => {
  it("TTL expiry → the online sender receives ack(dropped_offline) carrying the original msg id", async (t) => {
    const { broker, sock } = await setup(t, { config: { mailboxTtlMs: 200 } });
    const alice = await RawClient.connect(sock);
    t.after(() => alice.close());
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");

    const bob1 = await RawClient.connect(sock);
    bob1.hello("bob");
    await bob1.waitFrame((f) => f.type === "welcome");
    bob1.close();
    await sleep(150); // broker observes the close → bob is a known offline alias

    alice.send({ type: "msg", from: "alice", to: "bob", body: "gone-later", id: "m_dropnotice1" });
    const ack = await alice.waitFrame((f) => f.type === "ack");
    assert.equal(ack.status, "queued_offline");

    await sleep(300); // past the 200 ms TTL
    broker.purgeMailboxExpired(); // deterministic purge (independent of the 60 s interval)

    const notice = await alice.waitFrame(
      (f) => f.type === "ack" && f.status === "dropped_offline",
    );
    assert.equal(notice.id, "m_dropnotice1"); // correlates the ORIGINAL message
    assert.equal(notice.to, "bob"); // the mailbox it was bound for
    assert.equal(broker.state.stats.mailboxDropped, 1);
  });

  it("cap eviction → the evicted entry produces an immediate drop notice", async (t) => {
    const { broker, sock } = await setup(t, { config: { mailboxCap: 1 } });
    const alice = await RawClient.connect(sock);
    t.after(() => alice.close());
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob1 = await RawClient.connect(sock);
    bob1.hello("bob");
    await bob1.waitFrame((f) => f.type === "welcome");
    bob1.close();
    await sleep(150);

    alice.send({ type: "msg", from: "alice", to: "bob", body: "first", id: "m_dropnotice2a" });
    await alice.waitFrame((f) => f.type === "ack");
    alice.send({ type: "msg", from: "alice", to: "bob", body: "second", id: "m_dropnotice2b" });
    await alice.waitFrame((f) => f.type === "ack" && f.status === "queued_offline");

    const notice = await alice.waitFrame(
      (f) => f.type === "ack" && f.status === "dropped_offline",
    );
    assert.equal(notice.id, "m_dropnotice2a"); // the OLDEST was evicted
    assert.equal(broker.state.stats.mailboxDropped, 1);

    // bob returns: only the survivor is delivered
    const bob2 = await RawClient.connect(sock);
    t.after(() => bob2.close());
    bob2.hello("bob");
    const welcome = await bob2.waitFrame((f) => f.type === "welcome");
    assert.equal(welcome.mailboxCount, 1);
  });

  it("expired-at-flush: entries that aged out while the owner was away also notify the sender", async (t) => {
    const { broker, sock } = await setup(t, { config: { mailboxTtlMs: 200 } });
    const alice = await RawClient.connect(sock);
    t.after(() => alice.close());
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob1 = await RawClient.connect(sock);
    bob1.hello("bob");
    await bob1.waitFrame((f) => f.type === "welcome");
    bob1.close();
    await sleep(150);

    alice.send({ type: "msg", from: "alice", to: "bob", body: "aged-out", id: "m_dropnotice3" });
    await alice.waitFrame((f) => f.type === "ack");
    await sleep(300); // TTL passes while bob is still away

    const bob2 = await RawClient.connect(sock);
    t.after(() => bob2.close());
    bob2.hello("bob");
    const welcome = await bob2.waitFrame((f) => f.type === "welcome");
    assert.equal(welcome.mailboxCount, 0); // nothing left to deliver

    const notice = await alice.waitFrame(
      (f) => f.type === "ack" && f.status === "dropped_offline",
    );
    assert.equal(notice.id, "m_dropnotice3");
  });
});
