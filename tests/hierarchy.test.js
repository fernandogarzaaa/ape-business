// L3 hierarchy: planner artifacts (Skein graphs), claim/release mechanics, and
// a mock supervisor fanning out real delegated children per node.
// Isolated data dir (ledger) + isolated CWD (Skein .skein/ state lives in CWD).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const workdir = mkdtempSync(join(tmpdir(), "ape-hier-ws-"));
process.env.APE_DATA_DIR = mkdtempSync(join(tmpdir(), "ape-hier-"));
process.env.APE_ALLOW_MOCK_INPUT = "1";

const { loadProfile } = await import("../src/agent/profiles.js");
const { runAgent } = await import("../src/agent/loop.js");
const { dispatchCall } = await import("../src/server.js");
const runs = await import("../src/runs.js");

const savedCwd = process.cwd();
process.chdir(workdir);
test.after(() => { process.chdir(savedCwd); });

const CHILD = `name: hier-child-mock
description: hermetic hierarchy child
model: { provider: mock, id: mock-model }
system: test child
tools:
  - builtin: finish
limits: { max_steps: 5, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0 }
`;
function writeChildProfile() {
  const dir = join(process.env.APE_DATA_DIR, "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hier-child-mock.yaml"), CHILD);
}
const supervisorProfile = () => ({
  name: "hier-super",
  model: { provider: "mock", id: "mock-model" },
  system: "test supervisor",
  tools: [{ engine: "skein.orchestrate" }, { builtin: "delegate" }, { builtin: "finish" }],
  limits: { max_steps: 15, max_tokens: 200000, max_wall_seconds: 300, max_usd: 2.0, max_delegate_depth: 2 },
  policy: { verify_before_finish: "off" },
  stop_conditions: ["no_tool_call_in_step", "explicit_final_answer", "budget_exhausted"],
});

test("hierarchy: node-add creates plan nodes visible in status", async () => {
  const r = await dispatchCall("ape_orchestrate", {
    op: "node-add", node: "h-plan-1", title: "Investigate", goal: "find cause",
    completion: "cause written down",
  });
  const res = r.structuredContent.result;
  assert.equal(res.ok, true, "orchestrate node-add ok, got: " + JSON.stringify(res).slice(0, 200));
  assert.ok(!res.error, "node added, got: " + JSON.stringify(res).slice(0, 200));
  const st = await dispatchCall("ape_orchestrate", { op: "status" });
  const text = JSON.stringify(st.structuredContent.result);
  assert.ok(text.includes("h-plan-1"), "plan node inspectable before execution");
});

test("hierarchy: claim and release round-trip through the tool", async () => {
  await dispatchCall("ape_orchestrate", { op: "node-add", node: "h-claim-1", title: "Claim me" });
  const c = await dispatchCall("ape_orchestrate", { op: "claim", node: "h-claim-1", agent_id: "ape-mcp" });
  assert.equal(c.structuredContent.result.ok, true, "claim ok: " + JSON.stringify(c.structuredContent.result).slice(0, 200));
  assert.ok(!JSON.stringify(c.structuredContent.result).includes("error"), "claimed: " + JSON.stringify(c.structuredContent.result).slice(0, 160));
  const held = JSON.stringify((await dispatchCall("ape_orchestrate", { op: "status" })).structuredContent.result);
  assert.ok(held.includes("ape-mcp"), "lease holder visible");
  const rel = await dispatchCall("ape_orchestrate", { op: "release", node: "h-claim-1" });
  assert.ok(!JSON.stringify(rel.structuredContent.result).toLowerCase().includes("cannot release"), "released cleanly");
});

test("hierarchy: supervisor fans out one delegate per node, then synthesizes", async () => {
  writeChildProfile();
  const res = await runAgent({
    profile: supervisorProfile(),
    objective: "run the plan",
    mockScript: [
      { tool: "skein.orchestrate", args: { op: "node-add", node: "h-n1", title: "Workstream one", completion: "done one" } },
      { tool: "skein.orchestrate", args: { op: "node-add", node: "h-n2", title: "Workstream two", completion: "done two" } },
      { calls: [
        { tool: "delegate", args: { profile: "hier-child-mock", objective: "do workstream one", budget_share: 0.3 } },
        { tool: "delegate", args: { profile: "hier-child-mock", objective: "do workstream two", budget_share: 0.3 } },
      ] },
      { tool: "finish", args: { summary: "synthesis: both workstreams complete" } },
    ],
    resolvedModel: { provider: "mock", id: "mock-model" },
    parentRunId: "run-h-parent",
  });
  assert.equal(res.stop_reason, "explicit_final_answer");
  // Plan artifact exists independent of execution.
  const stRaw = (await dispatchCall("ape_orchestrate", { op: "status" })).structuredContent.result;
  assert.equal(stRaw.ok, true, "orchestrate status ok, got: " + JSON.stringify(stRaw).slice(0, 200));
  const st = JSON.stringify(stRaw);
  assert.ok(st.includes("h-n1") && st.includes("h-n2"), "both plan nodes exist");
  // Two children fanned out, both linked, both terminal.
  assert.equal(res.receipt.delegations.length, 2, "one delegate per node");
  assert.ok(res.receipt.delegated_cost_usd >= 0);
  for (const d of res.receipt.delegations) {
    const child = runs.getRun(d.run_id);
    assert.equal(child.parent_run_id, "run-h-parent", "child linked to supervisor");
    assert.notEqual(child.status, "running", "child terminal");
  }
  // Parallel fan-out fired (2 delegates in one turn).
  assert.equal(res.receipt.parallel_fanouts, 1, "delegations fanned out concurrently");
});

test("hierarchy: supervisor profile ships with delegate + orchestrate", () => {
  const p = loadProfile("supervisor");
  assert.ok(p, "supervisor profile loads");
  assert.ok(p.tools.some((t) => t.builtin === "delegate"), "supervisor can delegate");
  assert.ok(p.tools.some((t) => t.engine === "skein.orchestrate"), "supervisor sees the graph");
  assert.ok((p.limits.max_delegate_depth ?? 0) >= 2, "depth allows a hierarchy");
});
