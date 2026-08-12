// test/reply-dedup.test.ts — D25: a reply to an already-handled msgId is
// dropped (no re-injection), and replies interrupt via steer (not followUp).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { MeshClient, type SendResult } from "../src/client/client.js";
import type { MeshFrame } from "../src/protocol/envelope.js";
import { formatInboundContent, mapReplyDelivery } from "../src/extension/inbound.js";
import { makeTempDirs, startTestBroker, waitFor, type TempDirs } from "./helpers.js";

function withTimeout<T>(p: Promise<T>, ms = 5000, label = "async"): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
      t.unref();
    }),
  ]);
}

describe("reply dedup (D25)", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let lead: MeshClient;
  let bob: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-dedup-");
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

  it("first orphan reply is injected, second reply to the SAME msgId is dropped", async () => {
    const msgP = new Promise<MeshFrame>((resolve) => {
      bob.once("inbound", (f: MeshFrame) => resolve(f));
    });
    const sent = await lead.send({ to: "bob", message: "mission long" });
    assert.equal(sent.status, "delivered");
    const msg = await withTimeout(msgP, 5000, "bob inbound");

    // lead does NOT awaitReply → first reply is orphan-injected
    const firstP = new Promise<MeshFrame>((resolve) => {
      lead.once("inbound", (f: MeshFrame) => resolve(f));
    });
    const r1 = await bob.reply(msg.id, "answer #1");
    assert.equal(r1.status, "delivered");
    const injected = await withTimeout(firstP, 5000, "first orphan inject");
    assert.equal(injected.body, "answer #1");

    // bob re-sends the EXACT SAME answer (remind-driven re-send pattern) →
    // must be dropped silently: no second inbound event on lead
    let secondInjected = false;
    lead.on("inbound", (f: MeshFrame) => {
      if (f.type === "reply") secondInjected = true;
    });
    const r2 = await bob.reply(msg.id, "answer #1"); // identical body
    assert.equal(r2.status, "delivered"); // delivered on the wire…
    await new Promise((r) => setTimeout(r, 300)); // …but not re-injected
    assert.equal(secondInjected, false, "identical re-send must not reach the session again");
  });

  it("awaitReply consumes the first reply; a late duplicate is dropped, not re-injected", async () => {
    const msgP = new Promise<MeshFrame>((resolve) => {
      bob.once("inbound", (f: MeshFrame) => resolve(f));
    });
    // NOTE: do NOT await an awaitReply send before bob answers — the promise
    // only settles once the reply arrives (or times out).
    const sentP = lead.send({ to: "bob", message: "await me", awaitReply: true, timeoutMs: 30_000 });
    const msg = await withTimeout(msgP, 5000, "bob inbound");

    // first reply resolves the pending → the send() promise carries the answer
    const replyDone = bob.reply(msg.id, "the answer");
    const awaited = await withTimeout(sentP, 8000, "awaitReply");
    assert.equal(awaited.status, "reply");
    assert.equal(awaited.response, "the answer");
    await replyDone;

    // late re-send of the SAME answer (after the pending was consumed) → dropped
    let injected = false;
    lead.on("inbound", (f: MeshFrame) => {
      if (f.type === "reply") injected = true;
    });
    const dup = await bob.reply(msg.id, "the answer"); // identical body
    assert.equal(dup.status, "delivered");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(injected, false, "identical late re-send must not be re-injected");
  });

  it("a reply to a DIFFERENT msgId is still injected (no over-dedup)", async () => {
    const msgP = new Promise<MeshFrame>((resolve) => {
      bob.once("inbound", (f: MeshFrame) => resolve(f));
    });
    await lead.send({ to: "bob", message: "q-other" });
    const msg = await withTimeout(msgP, 5000, "bob inbound 2");
    const firstP = new Promise<MeshFrame>((resolve) => {
      lead.once("inbound", (f: MeshFrame) => resolve(f));
    });
    await bob.reply(msg.id, "fresh answer");
    const got = await withTimeout(firstP, 5000, "fresh inject");
    assert.equal(got.body, "fresh answer");
  });
});

describe("reply delivery mode (D25)", () => {
  it("reply frames map to steer (interrupt the reflection), not followUp", () => {
    const reply = { type: "reply" as const, id: "m_x", ts: "2026-08-10T00:00:00.000Z" };
    assert.equal(mapReplyDelivery(reply as unknown as MeshFrame), "steer");
    const msg = { type: "msg" as const, id: "m_y", ts: "2026-08-10T00:00:00.000Z" };
    assert.equal(mapReplyDelivery(msg as unknown as MeshFrame), "followUp");
    const urgent = { type: "msg" as const, id: "m_z", priority: "urgent" as const, ts: "2026-08-10T00:00:00.000Z" };
    assert.equal(mapReplyDelivery(urgent as unknown as MeshFrame), "steer");
  });

  it("remind format tells the agent to ignore if already answered", () => {
    const f = {
      type: "remind",
      id: "m_remind",
      from: "lead",
      to: "bob",
      replyTo: "m_orig_12345678",
      ts: "2026-08-10T00:00:00.000Z",
    };
    const content = formatInboundContent(f as unknown as MeshFrame);
    assert.ok(content.includes("IGNORE ce rappel si tu as DÉJÀ répondu"), content);
  });
});

describe("reply dedup by content (D25 v2)", () => {
  it("a DIFFERENT answer to the same msgId is delivered (ack → final report)", async () => {
    const dirs = makeTempDirs("mesh-dedup2-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const lead = new MeshClient({ alias: "lead", runtimeDir: dirs.runtimeDir });
    const bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir });
    await Promise.all([lead.connect(), bob.connect()]);
    try {
      const msgP = new Promise<MeshFrame>((resolve) => {
        bob.once("inbound", (f: MeshFrame) => resolve(f));
      });
      await lead.send({ to: "bob", message: "RE V1-NOIR" });
      const msg = await withTimeout(msgP, 5000, "bob inbound");

      const got: string[] = [];
      lead.on("inbound", (f: MeshFrame) => {
        if (f.type === "reply") got.push(f.body ?? "");
      });
      // ack first
      await bob.reply(msg.id, "RE V1-NOIR reçue — chasse aux valeurs");
      // then the final report — SAME msgId, DIFFERENT body → must be delivered
      await bob.reply(msg.id, "RE V1-NOIR TERMINÉE — rapport web/tools/re_v1_black.md");
      await new Promise((r) => setTimeout(r, 300));
      assert.deepEqual(got, [
        "RE V1-NOIR reçue — chasse aux valeurs",
        "RE V1-NOIR TERMINÉE — rapport web/tools/re_v1_black.md",
      ]);
    } finally {
      await lead.close().catch(() => {});
      await bob.close().catch(() => {});
      await broker.close();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});

describe("reply-to-reply info-only (D39: the LLM judges)", () => {
  it("a reply to a REPLY is injected with the chain flag; a reply to a MISSION is normal", async () => {
    const dirs = makeTempDirs("mesh-loop-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const lead = new MeshClient({ alias: "lead", runtimeDir: dirs.runtimeDir });
    const bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir });
    await Promise.all([lead.connect(), bob.connect()]);
    try {
      // lead envoie une mission → bob répond (reply-à-mission, injecté chez lead)
      const msgP = new Promise<MeshFrame>((resolve) => {
        bob.once("inbound", (f: MeshFrame) => resolve(f));
      });
      await lead.send({ to: "bob", message: "MISSION" });
      const mission = await withTimeout(msgP, 5000, "bob inbound");
      const r1P = new Promise<MeshFrame>((resolve) => {
        lead.once("inbound", (f: MeshFrame) => resolve(f));
      });
      const r1 = await bob.reply(mission.id, "MISSION TERMINÉE");
      const injected = await withTimeout(r1P, 5000, "mission reply injected");
      assert.equal(injected.body, "MISSION TERMINÉE");

      // lead répond au reply de bob (reply-à-reply) — livré, et bob le reçoit
      const r2P = new Promise<MeshFrame>((resolve) => {
        bob.once("inbound", (f: MeshFrame) => resolve(f));
      });
      const r2 = await lead.reply(injected.id, "merci !");
      assert.equal(r2.status, "delivered");
      const gotR2 = await withTimeout(r2P, 5000, "bob got r2");
      assert.equal(gotR2.type, "reply");
      // D39: le client TAGGE le reply-à-reply pour l'extension (info-only)
      assert.equal(bob.isReplyToReply(gotR2.replyTo ?? ""), true);
      // le reply-à-reply de la mission n'est PAS taggé
      assert.equal(lead.isReplyToReply(injected.replyTo ?? ""), false);
    } finally {
      await lead.close().catch(() => {});
      await bob.close().catch(() => {});
      await broker.close();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
