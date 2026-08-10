// test/reservations.test.ts — D21 file reservation matching (pure functions).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findConflict,
  normalizePath,
  pathMatchesReservation,
} from "../src/extension/reservations.js";
import type { FileReservation } from "../src/protocol/envelope.js";

describe("reservations: path matching", () => {
  it("exact file pattern matches the file only", () => {
    assert.ok(pathMatchesReservation("web/webgpu-viewer.js", "web/webgpu-viewer.js"));
    assert.ok(!pathMatchesReservation("web/webgpu-viewer.html", "web/webgpu-viewer.js"));
    assert.ok(!pathMatchesReservation("web/tools/webgpu-viewer.js", "web/webgpu-viewer.js"));
  });

  it("trailing slash reserves the whole subtree", () => {
    assert.ok(pathMatchesReservation("web/tools/a.js", "web/tools/"));
    assert.ok(pathMatchesReservation("web/tools/deep/nested/b.js", "web/tools/"));
    assert.ok(pathMatchesReservation("web/tools", "web/tools/"));
    assert.ok(!pathMatchesReservation("web/toolbox/a.js", "web/tools/"));
  });

  it("normalizes backslashes and ./ prefixes", () => {
    assert.ok(pathMatchesReservation("web\\tools\\a.js", "web/tools/"));
    assert.ok(pathMatchesReservation("./web/tools/a.js", "web/tools/"));
  });

  it("normalizePath case-folds on Windows", () => {
    // The fold is platform-dependent; on Windows NTFS paths compare case-insensitively.
    const folded = normalizePath("Web/Tools/A.js");
    if (process.platform === "win32") {
      assert.equal(folded, "web/tools/a.js");
    } else {
      assert.equal(folded, "Web/Tools/A.js");
    }
  });
});

describe("reservations: conflict lookup", () => {
  const aliceRes: FileReservation[] = [
    { pattern: "web/webgpu-viewer.js", reason: "integrating", since: "2026-08-10T00:00:00.000Z" },
    { pattern: "web/shaders/", since: "2026-08-10T00:00:00.000Z" },
  ];
  const map = new Map<string, readonly FileReservation[]>([
    ["alice", aliceRes],
    ["bob", [{ pattern: "web/tools/analyze_vmat.mjs" }]],
  ]);

  it("returns the holder for a conflicting path", () => {
    const c = findConflict("web/webgpu-viewer.js", map, "carol");
    assert.ok(c !== undefined);
    assert.equal(c?.alias, "alice");
    assert.equal(c?.reservation.reason, "integrating");
  });

  it("matches directory reservations", () => {
    const c = findConflict("web/shaders/vertexlit.wgsl", map, "carol");
    assert.equal(c?.alias, "alice");
  });

  it("ignores the caller's own reservations", () => {
    assert.equal(findConflict("web/webgpu-viewer.js", map, "alice"), undefined);
  });

  it("returns undefined when no one holds the path", () => {
    assert.equal(findConflict("web/other/file.js", map, "carol"), undefined);
  });

  it("honors a second holder on the same path", () => {
    const c = findConflict("web/tools/analyze_vmat.mjs", map, "carol");
    assert.equal(c?.alias, "bob");
  });
});
