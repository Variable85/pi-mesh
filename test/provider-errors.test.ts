// test/provider-errors.test.ts — transient vs permanent provider errors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTransientProviderError, providerErrorState } from "../src/extension/provider-errors.js";

describe("provider error classification", () => {
  it("429 and 5xx are TRANSIENT → rate_limited (retry later is fine)", () => {
    for (const s of [429, 408, 425, 500, 502, 503, 504]) {
      assert.equal(isTransientProviderError(s), true, `status ${s}`);
      assert.equal(providerErrorState(s), "rate_limited", `status ${s}`);
    }
  });

  it("401/403/404 and other 4xx are PERMANENT → blocked (retrying won't heal)", () => {
    for (const s of [400, 401, 402, 403, 404, 405, 413, 422]) {
      assert.equal(isTransientProviderError(s), false, `status ${s}`);
      assert.equal(providerErrorState(s), "blocked", `status ${s}`);
    }
  });

  it("success statuses are not errors", () => {
    for (const s of [200, 201, 204, 304]) {
      assert.equal(providerErrorState(s), undefined);
    }
  });
});
