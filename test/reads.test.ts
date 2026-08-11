// test/reads.test.ts — D34: read receipts (honest delivered ≠ read).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import type { MeshFrame } from "../src/protocol/envelope.js";
import { makeTempDirs, startTestBroker, waitFor, type TempDirs } from "./helpers.js";

describe("read receipts (D34)", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let lead: MeshClient;
  let bob: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-reads-");
    broker = await startTestBroker(dirs.runtimeDir);
    lead = new MeshClient({ alias: "lead", runtimeDir: dirs.runtimeDir });
    bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir });
    await Promise.all([lead.connect(), bob.connect()]);
  });

  after(async () => {
    await lead.close().catch(() => {});
    await bob.close().catch(() => {});
    await broker.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it("the recipient's read receipt reaches the original sender", async () => {
    const msgP = new Promise<MeshFrame>((resolve) => {
      bob.once("inbound", (f: MeshFrame) => resolve(f));
    });
    const sent = await lead.send({ to: "bob", message: "mission X" });
    assert.equal(sent.status, "delivered");
    const msg = await msgP;

    // bob acknowledges reading it
    bob.sendRead(msg.id, "lead");
    await waitFor(() => (lead.readsOf(msg.id).length > 0 ? true : undefined));
    const reads = lead.readsOf(msg.id);
    assert.equal(reads[0]?.alias, "bob");
    assert.ok(reads[0]?.at);
  });

  it("reads are tracked per msgId and exposed via readReceipts()", async () => {
    const msgP = new Promise<MeshFrame>((resolve) => {
      bob.once("inbound", (f: MeshFrame) => resolve(f));
    });
    const sent = await lead.send({ to: "bob", message: "mission Y" });
    assert.ok(sent.msgId);
    const msg = await msgP;
    bob.sendRead(msg.id, "lead");
    await waitFor(() => (lead.readsOf(msg.id).length > 0 ? true : undefined));
    const receipts = lead.readReceipts(10);
    assert.ok(receipts.some((r) => r.msgId === msg.id && r.alias === "bob"));
  });

  it("sendRead when offline is a no-op (no crash)", async () => {
    await bob.close(); // bob offline now
    bob.sendRead("m_ghost", "lead"); // no-op, never throws
    assert.equal(lead.readsOf("m_ghost").length, 0);
  });
});
