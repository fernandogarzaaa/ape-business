// Live smoke test for the Meta Model API provider: one short call to
// muse-wonder-1.0, then print the model, token usage, and estimated cost.
// Requires META_API_KEY (or MODEL_API_KEY) in the environment. Without a key
// it exits without claiming anything, so CI and keyless runs stay honest.
// Usage: META_API_KEY=... node demo/meta-wonder-smoke.mjs
import { chat, estimateCost, resolveModel } from "../src/agent/providers.js";

const resolved = await resolveModel({ provider: "meta" });
if (resolved.error || !resolved.key) {
  console.log("SKIP: no Meta credential found (set META_API_KEY). No live call made.");
  process.exit(0);
}
const out = await chat(resolved, {
  system: "Reply with exactly one word.",
  messages: [{ role: "user", content: "Reply with exactly: ok" }],
  tools: [],
});
const cost = estimateCost(resolved.id, out.usage);
console.log(JSON.stringify({
  provider: resolved.provider,
  model: resolved.id,
  content: out.content,
  usage: out.usage,
  estimatedCostUsd: cost,
}, null, 2));
