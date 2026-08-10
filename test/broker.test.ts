// test/broker.test.ts — REAL broker on mkdtemp runtimeDir + raw socket clients.
// Covers E3, E4, E11, E12, E13, E14 (+forceDowngrade variant), E15, E16, E17,
// E18, E19 (disconnect → presence offline; closePeer unit), E21.
import assert from "node:assert/strict";
import type { Socket } from "node:net";
import { describe, it } from "node:test";
import { closePeer, type RunningBroker } from "../src/broker/broker.js";
import { joinRoom } from "../src/broker/rooms.js";
import { BrokerState, type PeerRecord } from "../src/broker/state.js";
import { buildFrame } from "../src/protocol/envelope.js";
import { sha256 } from "../src/protocol/frames.js";
import {
  brokerSocketPathOf,
  makeTempDirs,
  RawClient,
  sleep,
  startTestBroker,
  waitFor,
  type TempDirs,
} from "./helpers.js";

interface Fixture {
  dirs: TempDirs;
  broker: RunningBroker;
  sock: string;
}

async function withBroker(
  t: { after: (fn: () => void | Promise<void>) => void },
  overrides: Parameters<typeof startTestBroker>[1] = {},
): Promise<Fixture> {
  const dirs = makeTempDirs();
  t.after(() => dirs.cleanup());
  const broker = await startTestBroker(dirs.runtimeDir, overrides);
  t.after(async () => {
    await broker.close();
  });
  return { dirs, broker, sock: brokerSocketPathOf(dirs.runtimeDir) };
}

function trackRaw(t: { after: (fn: () => void) => void }, raw: RawClient): RawClient {
  t.after(() => raw.close());
  return raw;
}

describe("broker: identity & handshake", () => {
  it("E3: double hello same alias → exactly 1 welcome + 1 alias_taken", async (t) => {
    const { sock } = await withBroker(t);
    const a = trackRaw(t, await RawClient.connect(sock));
    const b = trackRaw(t, await RawClient.connect(sock));
    a.hello("racer");
    b.hello("racer");
    const welcomes = await waitFor(() => {
      const w = [...a.frames, ...b.frames].filter((f) => f.type === "welcome");
      return w.length === 1 ? w : undefined;
    });
    assert.equal(welcomes.length, 1);
    const taken = await waitFor(() => {
      const e = [...a.frames, ...b.frames].filter((f) => f.type === "error" && f.code === "alias_taken");
      return e.length === 1 ? e : undefined;
    });
    assert.equal(taken.length, 1);
  });

  it("E12: uppercase/underscore aliases → invalid_alias; valid → welcome", async (t) => {
    const { sock } = await withBroker(t);
    const upper = trackRaw(t, await RawClient.connect(sock));
    upper.hello("Alice"); // not lowercase-normalized on the wire
    const e1 = await upper.waitFrame((f) => f.type === "error");
    assert.equal(e1.code, "invalid_alias");

    const under = trackRaw(t, await RawClient.connect(sock));
    under.hello("bad_alias"); // underscore refused (D4)
    const e2 = await under.waitFrame((f) => f.type === "error");
    assert.equal(e2.code, "invalid_alias");

    const ok = trackRaw(t, await RawClient.connect(sock));
    ok.hello("carol");
    const w = await ok.waitFrame((f) => f.type === "welcome");
    assert.equal(w.from, "carol");
  });

  it("non-hello frame before welcome → hello_required", async (t) => {
    const { sock } = await withBroker(t);
    const raw = trackRaw(t, await RawClient.connect(sock));
    raw.send({ type: "msg", from: "alice", to: "bob", body: "hi" });
    const e = await raw.waitFrame((f) => f.type === "error");
    assert.equal(e.code, "hello_required");
  });
});

describe("broker: routing refusals", () => {
  it("E4: send to never-seen alias → peer_not_found", async (t) => {
    const { sock } = await withBroker(t);
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    alice.send({ type: "msg", from: "alice", to: "ghost", body: "boo" });
    const e = await alice.waitFrame((f) => f.type === "error");
    assert.equal(e.code, "peer_not_found");
  });

  it("E16: observer sending → observer_readonly", async (t) => {
    const { sock } = await withBroker(t);
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const obs = trackRaw(t, await RawClient.connect(sock));
    obs.hello("watcher", undefined, "observer");
    await obs.waitFrame((f) => f.type === "welcome");
    obs.send({ type: "msg", from: "watcher", to: "alice", body: "I watch" });
    const e = await obs.waitFrame((f) => f.type === "error");
    assert.equal(e.code, "observer_readonly");
  });

  it("leaving the last room is allowed (0 rooms — peer is roomless)", async (t) => {
    const { sock } = await withBroker(t);
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    alice.send({ type: "leave", from: "alice", room: "default" });
    const ack = await alice.waitFrame((f) => f.type === "ack");
    assert.equal(ack.status, "ok");
    // roomless peer can no longer send into default
    alice.send({ type: "msg", from: "alice", to: "bob", body: "hi" });
    const e = await alice.waitFrame((f) => f.type === "error");
    assert.equal(e.code, "not_member");
  });

  it("E18: msg on a room the sender does not share → not_member", async (t) => {
    const { sock } = await withBroker(t);
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob = trackRaw(t, await RawClient.connect(sock));
    bob.hello("bob");
    await bob.waitFrame((f) => f.type === "welcome");
    alice.send({ type: "msg", from: "alice", to: "bob", room: "elsewhere", body: "x" });
    const e = await alice.waitFrame((f) => f.type === "error");
    assert.equal(e.code, "not_member");
  });

  it("E11: frame > maxFrameBytes → connection closed (oversized)", async (t) => {
    const { sock } = await withBroker(t, { config: { maxFrameBytes: 1024 } });
    const raw = trackRaw(t, await RawClient.connect(sock, 1 << 20));
    raw.hello("alice");
    await raw.waitFrame((f) => f.type === "welcome");
    raw.sendRaw(Buffer.from("x".repeat(2048), "utf8")); // oversized partial line
    await raw.waitClosed();
    assert.equal(raw.closed, true);
    const err = raw.frames.find((f) => f.type === "error");
    if (err !== undefined) assert.equal(err.code, "oversized"); // best-effort pre-close frame
  });

  it("E21: bodyHash mismatch → hash_mismatch", async (t) => {
    const { sock } = await withBroker(t);
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob = trackRaw(t, await RawClient.connect(sock));
    bob.hello("bob");
    await bob.waitFrame((f) => f.type === "welcome");
    const f = buildFrame({ type: "msg", from: "alice", to: "bob", body: "hello" });
    f.bodyHash = sha256("tampered");
    alice.sendFrame(f);
    const e = await alice.waitFrame((x) => x.type === "error");
    assert.equal(e.code, "hash_mismatch");
  });
});

describe("broker: rate limits & force policy", () => {
  it("E15: 31 fast msgs → at least 1 rate_limited, ≤ 30 delivered acks", async (t) => {
    const { sock } = await withBroker(t);
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob = trackRaw(t, await RawClient.connect(sock));
    bob.hello("bob");
    await bob.waitFrame((f) => f.type === "welcome");
    for (let i = 0; i < 31; i += 1) {
      alice.send({ type: "msg", from: "alice", to: "bob", body: `burst-${i}` });
    }
    const limited = await alice.waitFrames((f) => f.type === "error" && f.code === "rate_limited", 1);
    assert.ok(limited.length >= 1);
    const delivered = alice.frames.filter((f) => f.type === "ack" && f.status === "delivered");
    assert.ok(delivered.length <= 30, `delivered=${delivered.length}`);
  });

  it("E13: force without reasonHash → force_requires_reason", async (t) => {
    const { sock } = await withBroker(t);
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob = trackRaw(t, await RawClient.connect(sock));
    bob.hello("bob");
    await bob.waitFrame((f) => f.type === "welcome");
    alice.send({ type: "msg", from: "alice", to: "bob", body: "stop", priority: "force" });
    const e = await alice.waitFrame((f) => f.type === "error");
    assert.equal(e.code, "force_requires_reason");
  });

  it("E14: force from unauthorized alias → policy_denied", async (t) => {
    const { sock } = await withBroker(t, { policy: { forceAllowedFrom: ["lead"] } });
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob = trackRaw(t, await RawClient.connect(sock));
    bob.hello("bob");
    await bob.waitFrame((f) => f.type === "welcome");
    alice.send({
      type: "msg", from: "alice", to: "bob", body: "stop", priority: "force", reasonHash: sha256("r"),
    });
    const e = await alice.waitFrame((f) => f.type === "error");
    assert.equal(e.code, "policy_denied");
  });

  it("E14 variant: forceDowngrade → delivered with interruptStatus force_downgraded", async (t) => {
    const { sock } = await withBroker(t, {
      policy: { forceAllowedFrom: ["lead"], forceDowngrade: true },
    });
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob = trackRaw(t, await RawClient.connect(sock));
    bob.hello("bob");
    await bob.waitFrame((f) => f.type === "welcome");
    alice.send({
      type: "msg", from: "alice", to: "bob", body: "stop", priority: "force", reasonHash: sha256("r"),
    });
    const ack = await alice.waitFrame((f) => f.type === "ack");
    assert.equal(ack.status, "delivered");
    assert.equal(ack.interruptStatus, "force_downgraded");
    const got = await bob.waitFrame((f) => f.type === "msg");
    assert.equal(got.priority, "urgent"); // downgraded on the wire
  });
});

describe("broker: presence (E19)", () => {
  it("E19: abrupt disconnect → presence(offline) broadcast to room members", async (t) => {
    const { sock } = await withBroker(t);
    const alice = trackRaw(t, await RawClient.connect(sock));
    alice.hello("alice");
    await alice.waitFrame((f) => f.type === "welcome");
    const bob = trackRaw(t, await RawClient.connect(sock));
    bob.hello("bob");
    await bob.waitFrame((f) => f.type === "welcome");
    // bob joins "ops" first; alice joining it pushes presence(online) to bob
    bob.send({ type: "join", from: "bob", room: "ops" });
    await bob.waitFrame((f) => f.type === "ack");
    alice.send({ type: "join", from: "alice", room: "ops" });
    const seenOnline = await bob.waitFrame(
      (f) => f.type === "presence" && f.from === "alice" && f.status === "online",
    );
    assert.equal(seenOnline.room, "ops");
    alice.close(); // abrupt socket close (what the 45 s silence sweep eventually causes)
    const off = await bob.waitFrame(
      (f) => f.type === "presence" && f.from === "alice" && f.status === "offline",
    );
    assert.equal(off.room, "default");
  });

  it("E19 unit: closePeer purges tables + broadcasts presence(offline)", () => {
    const state = new BrokerState();
    const writes: string[] = [];
    interface FakeSocket {
      destroyed: boolean;
      writable: boolean;
      write(d: string): boolean;
      destroy(): void;
    }
    const makeFakeSocket = (capture: string[] | null): Socket => {
      const sock: FakeSocket = {
        destroyed: false,
        writable: true,
        write(d: string): boolean {
          capture?.push(d);
          return true;
        },
        destroy(): void {
          sock.destroyed = true;
        },
      };
      return sock as unknown as Socket;
    };
    const alice: PeerRecord = {
      alias: "alice",
      socket: makeFakeSocket(null),
      rooms: new Map(),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      helloDone: true,
      reservations: [],
    };
    const bob: PeerRecord = {
      alias: "bob",
      socket: makeFakeSocket(writes),
      rooms: new Map(),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      helloDone: true,
      reservations: [],
    };
    state.peers.set("alice", alice);
    state.peers.set("bob", bob);
    const cfg = { maxRoomsPerPeer: 16 } as Parameters<typeof joinRoom>[1];
    joinRoom(state, cfg, alice, "default");
    joinRoom(state, cfg, bob, "default");
    closePeer(state, "alice", "test");
    assert.equal(state.peers.has("alice"), false);
    assert.equal(state.rooms.get("default")?.has("alice"), false);
    const line = writes.map((w) => JSON.parse(w) as Record<string, unknown>).find(
      (f) => f.type === "presence" && f.from === "alice",
    );
    assert.ok(line !== undefined);
    assert.equal(line.status, "offline");
  });
});

describe("broker: B2 stale write-failure guard (T-B2)", () => {
  it("stale write-failure after re-hello keeps the NEW peer, no presence(offline)", async (t) => {
    const { broker, sock } = await withBroker(t);
    const { state } = broker;
    const obs = trackRaw(t, await RawClient.connect(sock));
    obs.hello("obs");
    await obs.waitFrame((f) => f.type === "welcome");

    const victim1 = trackRaw(t, await RawClient.connect(sock));
    victim1.hello("victim");
    await victim1.waitFrame((f) => f.type === "welcome");
    const record1 = state.peers.get("victim");
    assert.ok(record1 !== undefined);

    const sender = trackRaw(t, await RawClient.connect(sock));
    sender.hello("sender");
    await sender.waitFrame((f) => f.type === "welcome");
    // sender's presence(online) broadcast went to record1's REAL socket above.
    // Only NOW swap record1's socket for a STUCK one: write() captures the
    // callback instead of flushing — the ONLY pending write on it will be the
    // routed msg below, so the captured callback is precisely the routeMsg
    // write-failure path.
    const stuckCbs: Array<(err?: Error | null) => void> = [];
    const stuck = {
      destroyed: false,
      writable: true,
      write(_data: unknown, cb?: (err?: Error | null) => void): boolean {
        if (cb) stuckCbs.push(cb);
        return true;
      },
      destroy(): void {
        stuck.destroyed = true;
      },
    };
    record1.socket = stuck as unknown as Socket;

    sender.send({ type: "msg", from: "sender", to: "victim", body: "hello victim" });
    await waitFor(() => stuckCbs.length === 1); // routeMsg writeFrame in-flight on the OLD socket

    // The alias re-hellos onto a NEW socket before the old write settles.
    stuck.destroyed = true; // old socket died silently (broker never ran closePeer)
    const victim2 = trackRaw(t, await RawClient.connect(sock));
    victim2.hello("victim");
    await victim2.waitFrame((f) => f.type === "welcome");
    const record2 = state.peers.get("victim");
    assert.ok(record2 !== undefined && record2 !== record1, "alias re-hello'd onto a new record");
    await obs.waitFrame(
      (f) => f.type === "presence" && f.from === "victim" && f.status === "online",
    );
    // The orphaned old client socket finally goes away: no peer record points
    // at it anymore, so the broker close handler must NOT closePeer anything.
    victim1.close();

    // NOW the stale write on the OLD socket fails.
    stuckCbs[0]?.(new Error("EPIPE"));

    // The write-failure callback still runs honestly: mailbox + queued_offline ack.
    const ack = await sender.waitFrame((f) => f.type === "ack");
    assert.equal(ack.status, "queued_offline");

    // …but the identity guard blocks closePeer on the healthy new record.
    assert.equal(state.peers.get("victim"), record2, "new peer record untouched");
    assert.equal(record2.socket.destroyed, false, "new peer socket still alive");
    await sleep(120);
    assert.equal(
      obs.frames.filter(
        (f) => f.type === "presence" && f.from === "victim" && f.status === "offline",
      ).length,
      0,
      "no presence(offline) broadcast for the healthy re-hello'd peer",
    );
    assert.equal(victim2.closed, false);
  });
});
