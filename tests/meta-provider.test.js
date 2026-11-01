// Tests for the Meta Model API provider wiring (Muse Wonder 1.0).
// These test the wiring, not a live Meta call: the live call needs a real
// META_API_KEY and is exercised by demo/meta-wonder-smoke.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { chat, defaultModelFor, estimateCost, resolveModel } from "../src/agent/providers.js";

test("meta default model is muse-wonder-1.0", () => {
  assert.equal(defaultModelFor("meta"), "muse-wonder-1.0");
});

test("meta cost estimate uses the reported Standard rate", () => {
  const cost = estimateCost("muse-wonder-1.0", { inputTokens: 1000000, outputTokens: 1000000 });
  assert.equal(cost, 24);
});

test("meta resolves from META_API_KEY", async () => {
  const prev = process.env.META_API_KEY;
  process.env.META_API_KEY = "test-meta-key";
  try {
    const r = await resolveModel({ provider: "meta" });
    assert.equal(r.provider, "meta");
    assert.equal(r.id, "muse-wonder-1.0");
    assert.equal(r.key, "test-meta-key");
  } finally {
    if (prev === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = prev;
  }
});

test("meta chat posts to the Meta Model API chat completions endpoint", async () => {
  const seen = {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen.url = url;
    seen.auth = opts.headers.authorization;
    seen.body = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    };
  };
  try {
    const out = await chat(
      { provider: "meta", id: "muse-wonder-1.0", key: "test-meta-key" },
      { system: "You are a test.", messages: [{ role: "user", content: "Reply with exactly: ok" }], tools: [] },
    );
    assert.equal(seen.url, "https://api.meta.ai/v1/chat/completions");
    assert.equal(seen.auth, "Bearer test-meta-key");
    assert.equal(seen.body.model, "muse-wonder-1.0");
    assert.equal(out.content, "ok");
    assert.equal(out.usage.inputTokens, 10);
    assert.equal(out.usage.outputTokens, 5);
  } finally {
    globalThis.fetch = realFetch;
  }
});
