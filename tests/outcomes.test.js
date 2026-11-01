// Outcome identity: stable family IDs, dedup lookup, cost-per-outcome, deprecation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.APE_DATA_DIR = mkdtempSync(join(tmpdir(), "ape-outcomes-"));

const { familyOf, normalizeObjective, profileHash, envFingerprint } = await import("../src/agent/outcomes.js");
const runs = await import("../src/runs.js");
const { runAgent } = await import("../src/agent/loop.js");

function finishRun({ objective, family, stop = "explicit_final_answer", unverified = 0, ph = "ph-a", eh = "env-a", model = "mock/mock-model", cost = 0.01, hash = "abc123" }) {
  const id = runs.createRun({ profile: "p", model: "m", objective, outcome_family: family, profile_hash: ph, env_hash: eh });
  runs.updateRun(id, { status: "done", stop_reason: stop, unverified, outcome_hash: hash, total_cost: cost, model, finished_at: new Date().toISOString() });
  return id;
}
const dupReq = (family, over = {}) => ({
  family, windowSec: 3600, profileHash: "ph-a", envHash: "env-a", model: "mock/mock-model", ...over,
});

test("outcomes: family is stable across case/punctuation, distinct across tasks", () => {
  assert.equal(familyOf("Triage flaky Windows tests!"), familyOf("triage flaky windows tests"));
  assert.notEqual(familyOf("triage flaky windows tests"), familyOf("bake chocolate cake"));
  assert.ok(familyOf("x").startsWith("fam-"));
  assert.equal(normalizeObjective("Resume run-id run-abc123def456 now"), "resume now");
});

test("outcomes: dedup reuses only verified successes with matching basis", () => {
  const fam = familyOf("dedup probe objective");
  const id = finishRun({ objective: "dedup probe objective", family: fam });
  assert.equal(runs.findDuplicate(dupReq(fam))?.run_id, id, "verified success reuses");
  assert.equal(runs.findDuplicate(dupReq(fam, { windowSec: 0 })), null, "window 0 disables");
  assert.equal(runs.findDuplicate(dupReq(fam, { organism_id: "other" })), null, "organism scoped");
  assert.equal(runs.findDuplicate(dupReq(fam, { excludeRunId: id })), null, "self excluded");
  assert.equal(runs.findDuplicate(dupReq("fam-nonexistent")), null, "unknown family");
  assert.equal(runs.findDuplicate(dupReq(fam, { profileHash: "ph-b" })), null, "profile change blocks reuse");
  assert.equal(runs.findDuplicate(dupReq(fam, { envHash: "env-b" })), null, "env change blocks reuse");
  assert.equal(runs.findDuplicate(dupReq(fam, { model: "other/model" })), null, "model change blocks reuse");
  assert.equal(runs.findDuplicate(dupReq(fam, { profileHash: null })), null, "missing basis fails closed");
});

test("outcomes: unverified / failed / halted priors never dedup", () => {
  const cases = [
    ["unverified finish", { unverified: 1 }],
    ["budget halt", { stop: "max_steps" }],
    ["drift halt", { stop: "error_spiral" }],
    ["repetition halt", { stop: "repetition_detected" }],
  ];
  for (const [name, attrs] of cases) {
    const fam = familyOf("dedup prior " + name);
    finishRun({ objective: "dedup prior " + name, family: fam, ...attrs });
    assert.equal(runs.findDuplicate(dupReq(fam)), null, `${name} must not dedup`);
  }
});

test("outcomes: profile/env fingerprints are stable and sensitive", () => {
  const p = { name: "x", tools: ["a"], policy: { destructive: "deny" } };
  assert.equal(profileHash(p), profileHash(structuredClone(p)), "stable");
  assert.notEqual(profileHash(p), profileHash({ ...p, policy: { destructive: "allow" } }), "policy change alters hash");
  assert.ok(profileHash(p).startsWith("ph-"));
  const conns = [{ name: "c", base_url: "https://a.example", operations: [{ name: "get" }] }];
  assert.equal(envFingerprint(conns), envFingerprint(structuredClone(conns)), "stable");
  assert.notEqual(envFingerprint(conns), envFingerprint([]), "surface change alters fingerprint");
});

test("outcomes: familyStats aggregates cost-per-outcome + variants + deprecation", () => {
  const fam = familyOf("stats probe objective");
  const a = runs.createRun({ profile: "p", model: "m", objective: "stats probe objective", outcome_family: fam });
  runs.updateRun(a, { status: "done", stop_reason: "explicit_final_answer", step_count: 4, total_cost: 0.02, outcome_hash: "v1", finished_at: new Date().toISOString() });
  const b = runs.createRun({ profile: "p", model: "m", objective: "stats probe objective", outcome_family: fam });
  runs.updateRun(b, { status: "done", stop_reason: "explicit_final_answer", step_count: 6, total_cost: 0.04, outcome_hash: "v2", finished_at: new Date().toISOString() });
  let s = runs.familyStats(fam);
  assert.equal(s.completed, 2);
  assert.equal(s.total_cost_usd, 0.06);
  assert.equal(s.avg_cost_usd, 0.03);
  assert.equal(s.avg_steps, 5);
  assert.equal(s.variants.length, 2);
  runs.deprecateVariant({ family: fam, outcome_hash: "v1", reason: "superseded by v2" });
  s = runs.familyStats(fam);
  assert.ok(s.variants.find((v) => v.outcome_hash === "v1")?.deprecated, "v1 flagged");
  assert.ok(!s.variants.find((v) => v.outcome_hash === "v2")?.deprecated, "v2 live");
  assert.equal(s.deprecated[0]?.reason, "superseded by v2");
});

test("outcomes: run receipt carries the family id", async () => {
  const res = await runAgent({
    profile: {
      name: "t", model: { provider: "mock", id: "mock-model" }, tools: [{ builtin: "finish" }],
      limits: { max_steps: 5, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0 },
      policy: { verify_before_finish: "off" },
    },
    objective: "Family Receipt Check!",
    mockScript: [{ tool: "finish", args: { summary: "done" } }],
  });
  assert.equal(res.receipt.family, familyOf("Family Receipt Check!"));
});

test("outcomes: outcome_status separates lifecycle from result", () => {
  const { outcomeStatus } = runs;
  assert.equal(outcomeStatus({ status: "running" }), "running");
  assert.equal(outcomeStatus({ status: "done", stop_reason: "explicit_final_answer", unverified: 0 }), "success");
  assert.equal(outcomeStatus({ status: "done", stop_reason: "explicit_final_answer", unverified: 1 }), "unverified");
  assert.equal(outcomeStatus({ status: "done", stop_reason: "dedup_reuse" }), "success");
  assert.equal(outcomeStatus({ status: "done", stop_reason: "max_usd" }), "exhausted");
  assert.equal(outcomeStatus({ status: "done", stop_reason: "spend_capped" }), "exhausted");
  assert.equal(outcomeStatus({ status: "done", stop_reason: "error_spiral" }), "failed");
  assert.equal(outcomeStatus({ status: "done", stop_reason: "repetition_detected" }), "failed");
  assert.equal(outcomeStatus({ status: "done", stop_reason: "model_error" }), "failed");
  assert.equal(outcomeStatus({ status: "done", stop_reason: "no_tool_call_in_step" }), "incomplete");
  assert.equal(outcomeStatus({ status: "stopped", stop_reason: "cancelled" }), "cancelled");
  // Surfaced on status responses, not just the helper.
  const id = runs.createRun({ profile: "p", model: "m", objective: "status probe" });
  runs.updateRun(id, { status: "done", stop_reason: "max_steps", finished_at: new Date().toISOString() });
  assert.equal(runs.getRun(id).outcome_status, "exhausted");
  assert.equal(runs.getRun("run-does-not-exist").outcome_status, "not_found");
});
