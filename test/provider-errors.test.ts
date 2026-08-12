// test/provider-errors.test.ts — transient vs permanent provider errors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTransientProviderError, providerErrorState, providerErrorStateFromMessage } from "../src/extension/provider-errors.js";

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

  it("the REAL OpenCode Go quota error is PERMANENT (blocked), not rate_limited", () => {
    // exact message observed live on the test agents — carries "429" AND
    // "Rate limit exceeded" but is a subscription limit, NOT a throttle
    const msg = 'Error: 429: {"type":"FreeUsageLimitError","message":"Error from provider (Console): Rate limit exceeded. Please try again later."}';
    assert.equal(providerErrorStateFromMessage(msg), "blocked");
  });

  it("a plain transient 429 is rate_limited", () => {
    assert.equal(providerErrorStateFromMessage("Error: 429: Rate limit reached, retry in 30s"), "rate_limited");
    assert.equal(providerErrorStateFromMessage("Provider overloaded (503)"), "rate_limited");
    assert.equal(providerErrorStateFromMessage("too many requests"), "rate_limited");
  });

  it("auth errors are blocked", () => {
    assert.equal(providerErrorStateFromMessage("Error: 401 Unauthorized"), "blocked");
    assert.equal(providerErrorStateFromMessage("invalid api key"), "blocked");
    assert.equal(providerErrorStateFromMessage("403 Forbidden"), "blocked");
    assert.equal(providerErrorStateFromMessage("insufficient_quota"), "blocked");
  });

  it("success statuses are not errors", () => {
    for (const s of [200, 201, 204, 304]) {
      assert.equal(providerErrorState(s), undefined);
    }
  });
});
