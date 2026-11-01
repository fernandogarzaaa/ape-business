import test from "node:test";
import assert from "node:assert";
import { classifyObjective, selectRoutedModel } from "../src/agent/router.js";

test("router: classifies trivial, coding, reasoning objectives", () => {
  const t = classifyObjective("Parse this JSON and extract the three error fields");
  assert.equal(t.category, "trivial");
  assert.ok(t.confidence > 0);

  const c = classifyObjective("Fix the flaky unit test in the auth module and add a regression test");
  assert.equal(c.category, "coding");

  const r = classifyObjective("Compare the two architectures and recommend which trade-off to accept");
  assert.equal(r.category, "reasoning");
});

test("router: no signal or tie falls through to general (no routing)", () => {
  const g = classifyObjective("Hello there, how are you today?");
  assert.equal(g.category, "general");
  assert.equal(g.confidence, 0);
});

test("router: trivial routes local when detected, else null", async () => {
  const yes = await selectRoutedModel("trivial", {
    detected: ["local", "nebius"],
    resolveProvider: async (p) => (p === "local" ? { provider: "local", id: "llama3", key: null } : { error: "x" }),
  });
  assert.ok(yes?.routed, "routed to local");
  assert.equal(yes.provider, "local");

  const no = await selectRoutedModel("trivial", {
    detected: ["nebius"],
    resolveProvider: async () => ({ error: "unavailable" }),
  });
  assert.equal(no, null, "no local detected means no route");
});

test("router: non-trivial categories never reroute", async () => {
  let called = false;
  for (const cat of ["coding", "reasoning", "general"]) {
    const r = await selectRoutedModel(cat, {
      detected: ["local"],
      resolveProvider: async () => { called = true; return { provider: "local", id: "x" }; },
    });
    assert.equal(r, null, `${cat} stays on normal resolution`);
  }
  assert.equal(called, false, "resolver never consulted for non-trivial");
});