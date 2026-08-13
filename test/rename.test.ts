// test/rename.test.ts — in-flight alias change (D22): re-hello under a new
// alias carries rooms + reservations; alias_taken refused; failure restores
// the previous identity.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import { makeTempDirs, startTestBroker, waitFor, type TempDirs } from "./helpers.js";

describe("client: in-flight alias rename", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let alice: MeshClient;
  let bob: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-rename-");
    broker = await startTestBroker(dirs.runtimeDir);
    alice = new MeshClient({ alias: "alice", runtimeDir: dirs.runtimeDir });
    bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir });
    await alice.connect();
    await bob.connect();
  });

  after(async () => {
    await alice.close().catch(() => {});
    await bob.close().catch(() => {});
    await broker.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it("rename switches the alias on the broker (old alias gone)", async () => {
    const res = await alice.rename("alice2");
    assert.equal(res.ok, true);
    assert.equal(alice.alias, "alice2");
    // old alias gone, new alias visible to bob
    await waitFor(async () => {
      const snap = await bob.status();
      return snap.peers.some((p) => p.alias === "alice2") ? snap : undefined;
    });
    const snap = await bob.status();
    assert.ok(!snap.peers.some((p) => p.alias === "alice"));
    assert.ok(snap.peers.some((p) => p.alias === "alice2"));
  });

  it("rooms joined at runtime are re-declared after rename", async () => {
    await alice.join("ops");
    const res = await alice.rename("alice3");
    assert.equal(res.ok, true);
    const snap = await alice.status();
    const self = snap.peers.find((p) => p.alias === "alice3");
    assert.ok(self?.rooms.includes("ops"), "ops room should survive the rename");
    assert.ok(self?.rooms.includes("default"));
  });

  it("reservations survive the rename (re-declared at hello)", async () => {
    await alice.reserve(["web/renamed.js"], "keep me");
    const res = await alice.rename("alice4");
    assert.equal(res.ok, true);
    await waitFor(() =>
      bob.reservationsOf("alice4").length > 0 ? true : undefined,
    );
    assert.equal(bob.reservationsOf("alice4")[0]?.pattern, "web/renamed.js");
    assert.equal(bob.reservationsOf("alice4")[0]?.reason, "keep me");
  });

  it("rename to a taken alias is refused and the old alias is restored", async () => {
    const res = await alice.rename("bob");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "alias_taken");
    assert.equal(alice.alias, "alice4");
    // still fully usable under the restored alias
    const snap = await bob.status();
    assert.ok(snap.peers.some((p) => p.alias === "alice4"));
  });

  it("invalid aliases are refused locally; same alias is a no-op success", async () => {
    assert.equal((await alice.rename("Bob!")).ok, false);
    const same = await alice.rename("alice4");
    assert.equal(same.ok, true);
    assert.equal(same.unchanged, true);
    assert.equal(alice.alias, "alice4");
  });

  it("the renamed peer can still send and receive messages", async () => {
    const res = await alice.send({ to: "bob", message: "post-rename" });
    assert.equal(res.status, "delivered");
  });

  it("leave resyncs joinedRooms on not_member (no stale rejoin after reconnect)", async () => {
    // Force a desync: the client believes it is in "ghost" (joinedRooms) but
    // the broker no longer has the membership (e.g. state lost server-side).
    await alice.join("ghost");
    broker.state.peers.get("alice4")?.rooms.delete("ghost");
    await assert.rejects(() => alice.leave("ghost"), /not_member/);
    // After a rename (re-hello), the ghost room must NOT be re-declared.
    const res = await alice.rename("alice5");
    assert.equal(res.ok, true);
    const snap = await alice.status();
    const self = snap.peers.find((p) => p.alias === "alice5");
    assert.ok(!self?.rooms.includes("ghost"));
  });

  it("left 'default' does NOT come back after a re-hello (rename)", async () => {
    // The bug: the broker auto-joined every peer to "default" at hello, so
    // /mesh leave default was undone by the next reconnect/rename.
    await alice.join("ops");
    await alice.leave("default");
    const before = await alice.status();
    let self = before.peers.find((p) => p.alias === "alice5");
    assert.ok(!self?.rooms.includes("default"));

    // re-hello (rename) — the exact moment "default" used to come back
    const res = await alice.rename("alice6");
    assert.equal(res.ok, true);
    const after = await alice.status();
    self = after.peers.find((p) => p.alias === "alice6");
    assert.ok(self !== undefined, "renamed peer visible");
    assert.ok(!self.rooms.includes("default"), "default must not come back");
    assert.ok(self.rooms.includes("ops"));
  });

  it("send falls back to a joined room when 'default' was left", async () => {
    await alice.leave("ops");
    await alice.join("work");
    // bob joins work too so the message can be routed
    await bob.join("work");
    const res = await alice.send({ to: "bob", message: "via work" });
    assert.equal(res.status, "delivered");
    await bob.leave("work");
  });

  it("rename retries a transient alias_taken (close-propagation race)", async () => {
    // Simulate the broker still holding the target alias for a moment —
    // the old socket's close has not propagated yet (e.g. right after
    // /mesh reset, when the user immediately re-aliases). The rename
    // must retry with backoff and succeed once the alias is released.
    const fakeSocket = { destroyed: false } as unknown as import("node:net").Socket;
    broker.state.peers.set("bob", {
      alias: "bob",
      socket: fakeSocket,
      rooms: new Map(),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      helloDone: true,
      reservations: [],
    });
    setTimeout(() => broker.state.peers.delete("bob"), 400).unref();
    const res = await alice.rename("bob");
    assert.equal(res.ok, true);
    assert.equal(alice.alias, "bob");
  });
});
