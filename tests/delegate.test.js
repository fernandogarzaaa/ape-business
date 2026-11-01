// L2 delegation: scoped child runs with sliced budgets, depth caps, and
// receipt linkage in both directions. Isolated data dir: delegation forks
// real workers and writes real ledger rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.APE_DATA_DIR = mkdtempSync(join(tmpdir(), "ape-delegate-"));
process.env.APE_ALLOW_MOCK_INPUT = "1";

const { sliceChildBudget, waitForRun } = await import("../src/agent/registry.js");
const { runAgent } = await import("../src/agent/loop.js");
const runs = await import("../src/runs.js");

const CHILD = `name: del-child-mock
description: hermetic child (mock provider, finishes immediately)
model: { provider: mock, id: mock-model }
system: test child
tools:
  - builtin: finish
limits: { max_steps: 5, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0 }
`;
function writeChildProfile() {
  const dir = join(process.env.APE_DATA_DIR, "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "del-child-mock.yaml"), CHILD);
}
const parentProfile = () => ({
  name: "del-parent",
  model: { provider: "mock", id: "mock-model" },
  system: "test parent",
  tools: [{ builtin: "delegate" }, { builtin: "finish" }],
  limits: { max_steps: 10, max_tokens: 100000, max_wall_seconds: 120, max_usd: 1.0, max_delegate_depth: 2 },
  policy: { verify_before_finish: "off" },
  stop_conditions: ["no_tool_call_in_step", "explicit_final_answer", "budget_exhausted"],
});

test("delegate: budget slicing is proportional, clamped, and fails closed", () => {
  const full = { stepsLeft: 10, tokensLeft: 10000, usdLeft: 1.0, wallMsLeft: 300000 };
  const s = sliceChildBudget(full, 0.5);
  assert.equal(s.share, 0.5);
  assert.equal(s.limits.max_steps, 5);
  assert.equal(s.limits.max_usd, 0.5);
  assert.equal(s.limits.max_wall_seconds, 150);
  assert.equal(sliceChildBudget(full, 0.9).share, 0.5, "share capped at half");
  assert.equal(sliceChildBudget(full, 0).share, 0.25, "zero share means default");
  assert.equal(sliceChildBudget({ ...full, wallMsLeft: null }, 0.25).limits.max_wall_seconds, 120, "no parent wall means child default");
  assert.ok(sliceChildBudget({ stepsLeft: 0, tokensLeft: 0, usdLeft: 0 }).error, "exhausted parent cannot delegate");
});

test("delegate: waitForRun returns terminal rows and enforces timeouts", async () => {
  const done = await waitForRun({ getRunFn: () => ({ status: "done" }) }, "x", 1000);
  assert.equal(done.terminal.status, "done");
  let killed = 0;
  const t0 = Date.now();
  const timed = await waitForRun({ getRunFn: () => ({ status: "running" }), killFn: () => { killed++; } }, "y", 80, 10);
  assert.ok(timed.timeout, "timeout reported");
  assert.equal(killed, 1, "kill invoked once");
  assert.ok(Date.now() - t0 < 2000, "bounded wait");
});

test("delegate: depth cap refuses without forking", async () => {
  const before = runs.listRuns(1000).length;
  const res = await runAgent({
    profile: parentProfile(),
    objective: "too deep",
    mockScript: [
      { tool: "delegate", args: { profile: "del-child-mock", objective: "x" } },
      { tool: "finish", args: { summary: "done" } },
    ],
    depth: 2,
  });
  assert.equal(res.stop_reason, "explicit_final_answer");
  const step = res.steps.find((s) => s.tool === "delegate");
  assert.ok(String(step.resultSummary).includes("delegation_depth_exceeded"), "cap enforced in-ledger");
  assert.equal(runs.listRuns(1000).length, before, "refused delegation forks nothing");
});

test("delegate: unknown child profile fails honestly", async () => {
  const res = await runAgent({
    profile: parentProfile(),
    objective: "ghost child",
    mockScript: [
      { tool: "delegate", args: { profile: "nope-missing", objective: "x" } },
      { tool: "finish", args: { summary: "done" } },
    ],
  });
  const step = res.steps.find((s) => s.tool === "delegate");
  assert.ok(String(step.resultSummary).includes("delegated_profile_not_found"));
});

test("delegate: admission refusal is non-fatal to the parent", async () => {
  const prev = process.env.APE_MAX_CONCURRENT_RUNS;
  process.env.APE_MAX_CONCURRENT_RUNS = "0";
  try {
    writeChildProfile();
    const res = await runAgent({
      profile: parentProfile(),
      objective: "refused child",
      mockScript: [
        { tool: "delegate", args: { profile: "del-child-mock", objective: "x" } },
        { tool: "finish", args: { summary: "parent continues" } },
      ],
    });
    assert.equal(res.stop_reason, "explicit_final_answer", "parent survives refused delegation");
    const step = res.steps.find((s) => s.tool === "delegate");
    assert.ok(String(step.resultSummary).includes("delegation_refused"));
  } finally {
    if (prev === undefined) delete process.env.APE_MAX_CONCURRENT_RUNS;
    else process.env.APE_MAX_CONCURRENT_RUNS = prev;
  }
});

test("delegate: end-to-end child run with two-way receipt linkage", async () => {
  writeChildProfile();
  const res = await runAgent({
    profile: parentProfile(),
    objective: "supervise this",
    mockScript: [
      { tool: "delegate", args: { profile: "del-child-mock", objective: "subtask one", budget_share: 0.5 } },
      { tool: "finish", args: { summary: "synthesized" } },
    ],
    parentRunId: "run-test-parent",
  });
  assert.equal(res.stop_reason, "explicit_final_answer");
  assert.equal(res.receipt.delegations.length, 1, "parent logs the delegation");
  const d = res.receipt.delegations[0];
  assert.ok(d.run_id.startsWith("run-"), "child id recorded");
  assert.ok(res.receipt.delegated_cost_usd >= 0, "delegated cost aggregated");
  const step = res.steps.find((s) => s.tool === "delegate");
  assert.ok(String(step.resultSummary).includes('"delegated":true'), "delegation marker in ledger");
  // Child side: real worker row, terminal, linked back to the parent.
  const child = runs.getRun(d.run_id);
  assert.equal(child.parent_run_id, "run-test-parent", "child points at parent");
  assert.notEqual(child.status, "running", "child reached terminal state");
  assert.ok(child.receipt && JSON.parse(child.receipt).parent_run_id === "run-test-parent", "child receipt carries linkage");
});
