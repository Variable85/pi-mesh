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

  it("invalid and identical aliases are refused locally", async () => {
    assert.equal((await alice.rename("Bob!")).ok, false);
    assert.equal((await alice.rename("alice4")).ok, false);
    assert.equal(alice.alias, "alice4");
  });

  it("the renamed peer can still send and receive messages", async () => {
    const res = await alice.send({ to: "bob", message: "post-rename" });
    assert.equal(res.status, "delivered");
  });
});
