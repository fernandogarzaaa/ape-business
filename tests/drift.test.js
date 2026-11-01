// Trajectory health: semantic looping warns, error spirals halt.
import { test } from "node:test";
import assert from "node:assert/strict";

const { initDrift, observeDrift, evaluateDrift, driftReceipt, driftConfig } = await import("../src/agent/drift.js");
const { runAgent } = await import("../src/agent/loop.js");

const profile = (policy = {}) => ({
  name: "t",
  model: { provider: "mock", id: "mock-model" },
  tools: [{ builtin: "memory.recall" }, { builtin: "finish" }],
  limits: { max_steps: 30, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0 },
  policy,
});

test("drift: same-tool wandering warns once per streak, then resets", () => {
  const s = initDrift();
  let warned = 0;
  let lastAdvisory = null;
  for (let i = 0; i < 6; i++) {
    observeDrift(s, { tool: "memory.recall", summary: `q${i}` });
    lastAdvisory = evaluateDrift({}, s).advisory ?? null;
    if (lastAdvisory) warned++;
  }
  assert.equal(warned, 1, "warns once on hitting the streak");
  assert.match(lastAdvisory ?? "", /wandering/, "advisory names the pattern");
  observeDrift(s, { tool: "memory.store", summary: "ok" });
  assert.equal(evaluateDrift({}, s).advisory, undefined, "tool change clears the streak");
  for (let i = 0; i < 6; i++) observeDrift(s, { tool: "memory.recall", summary: `r${i}` });
  assert.ok(evaluateDrift({}, s).advisory, "new streak warns again");
});

test("drift: consecutive errors halt as error_spiral; success resets", () => {
  const s = initDrift();
  observeDrift(s, { tool: "a", summary: '{"error":"boom"}' });
  observeDrift(s, { tool: "b", summary: "unknown_tool" });
  observeDrift(s, { tool: "c", summary: '{"error":"boom"}' });
  assert.ok(!evaluateDrift({}, s).halt, "3 errors still running");
  observeDrift(s, { tool: "d", summary: '{"error":"boom"}' });
  const e = evaluateDrift({}, s);
  assert.ok(e.halt && e.stopReason === "error_spiral", "4th consecutive error halts");
  const s2 = initDrift();
  observeDrift(s2, { tool: "a", summary: '{"error":"x"}' });
  observeDrift(s2, { tool: "a", summary: "fine" });
  observeDrift(s2, { tool: "a", summary: '{"error":"x"}' });
  assert.ok(!evaluateDrift({}, s2).halt, "success breaks the spiral");
  assert.equal(driftConfig({ policy: { drift: false } }), null, "drift:false opts out");
});

test("drift: loop halts an error spiral instead of burning budget", async () => {
  const steps = [];
  const res = await runAgent({
    profile: { ...profile({ verify_before_finish: "off" }), tools: [{ builtin: "not_real" }, { builtin: "finish" }] },
    objective: "spiral",
    mockScript: [
      { tool: "not_a_real_tool_xyz", args: {} },
      { tool: "not_a_real_tool_xyz", args: { n: 1 } },
      { tool: "not_a_real_tool_xyz", args: { n: 2 } },
      { tool: "not_a_real_tool_xyz", args: { n: 3 } },
      { tool: "finish", args: { summary: "never" } },
    ],
    onStep: (st) => steps.push(st),
  });
  assert.equal(res.stop_reason, "error_spiral");
  assert.ok(steps.filter((st) => st.kind === "tool").length <= 5, "halts before budget burn");
  assert.equal(res.receipt.drift.max_consecutive_errors, 4);
});

test("drift: wandering advisory does not stop a run that converges", async () => {
  const script = Array.from({ length: 7 }, (_, i) => ({ tool: "memory.recall", args: { query: `wander-${i}` } }));
  script.push({ tool: "finish", args: { summary: "converged" } });
  const res = await runAgent({
    profile: profile({ verify_before_finish: "off" }),
    objective: "wander",
    mockScript: script,
  });
  assert.equal(res.stop_reason, "explicit_final_answer");
  assert.equal(res.receipt.drift.warnings, 1, "one advisory recorded");
  assert.equal(res.receipt.drift.max_same_tool_streak, 7);
});
