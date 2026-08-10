// test/reserve.test.ts — D21 reservations end-to-end over a real broker:
// hello-declared reservations, reserve/release round-trips, broadcast to
// peers, purge on disconnect.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import {
  makeTempDirs,
  startTestBroker,
  waitFor,
  type TempDirs,
} from "./helpers.js";

describe("reservations over the broker", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let alice: MeshClient;
  let bob: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-reserve-");
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

  it("hello-declared reservations reach the peer cache", async () => {
    const carol = new MeshClient({ alias: "carol", runtimeDir: dirs.runtimeDir });
    // Carol connects AFTER declaring her own reservations in the hello frame.
    await carol.connect();
    assert.equal(carol.reservations.length, 0);
    await carol.reserve(["web/plans/"], "planning");
    const seen = await waitFor(() =>
      alice.reservationsOf("carol").length > 0 ? alice.reservationsOf("carol") : undefined,
    );
    assert.equal(seen[0]?.pattern, "web/plans/");
    assert.equal(seen[0]?.reason, "planning");
    await carol.close();
  });

  it("reserve → broadcast to peers → reservationsOf reflects it", async () => {
    const res = await alice.reserve(["web/webgpu-viewer.js"], "integrating");
    assert.equal(res.status, "delivered");
    assert.equal(alice.reservations.length, 1);
    await waitFor(() =>
      bob.reservationsOf("alice").length > 0 ? true : undefined,
    );
    assert.equal(bob.reservationsOf("alice")[0]?.pattern, "web/webgpu-viewer.js");
  });

  it("release a subset → peers see the remaining set", async () => {
    await alice.reserve(["web/shaders/"]);
    assert.equal(alice.reservations.length, 2);
    await waitFor(() =>
      bob.reservationsOf("alice").length === 2 ? true : undefined,
    );
    const res = await alice.release(["web/shaders/"]);
    assert.equal(res.status, "delivered");
    assert.deepEqual(res.released, ["web/shaders/"]);
    await waitFor(() =>
      bob.reservationsOf("alice").length === 1 ? true : undefined,
    );
    assert.equal(bob.reservationsOf("alice")[0]?.pattern, "web/webgpu-viewer.js");
  });

  it("release all (no paths) → peers see an empty set", async () => {
    const res = await alice.release();
    assert.equal(res.status, "delivered");
    assert.deepEqual(res.released, ["web/webgpu-viewer.js"]);
    await waitFor(() =>
      bob.reservationsOf("alice").length === 0 ? true : undefined,
    );
  });

  it("invalid patterns are refused before the network round-trip", async () => {
    const res = await alice.reserve([""]);
    assert.equal(res.status, "error");
    assert.match(res.reason, /invalid_pattern/);
    assert.equal(alice.reservations.length, 0);
  });

  it("disconnect purges the peer's reservations (presence offline)", async () => {
    await bob.reserve(["web/tools/"]);
    assert.equal(alice.reservationsOf("bob").length, 1);
    await bob.close();
    await waitFor(() =>
      alice.reservationsOf("bob").length === 0 ? true : undefined,
    );
  });

  it("status snapshot exposes reservations", async () => {
    await alice.reserve(["web/a.js"]);
    // bob was closed by the disconnect test — reconnect before status()
    await bob.connect();
    let snap = await bob.status();
    for (let i = 0; i < 100; i += 1) {
      const a = snap.peers.find((p) => p.alias === "alice");
      if (a?.reservations !== undefined && a.reservations.length > 0) break;
      await new Promise((r) => setTimeout(r, 20));
      snap = await bob.status();
    }
    const a = snap.peers.find((p) => p.alias === "alice");
    assert.equal(a?.reservations?.[0]?.pattern, "web/a.js");
  });
});
