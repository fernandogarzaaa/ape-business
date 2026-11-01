import test from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { analyzeProfile } from "../src/agent/analyze.js";
import { createRun, updateRun } from "../src/runs.js";
import { dispatchCall } from "../src/server.js";
import { dataDir } from "../src/trace.js";

function makeProfile(name) {
  const dir = join(dataDir(), "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), [
    `name: ${name}`,
    "description: test profile",
    "model:",
    "  provider: mock",
    "  id: mock-model",
    "system: test",
    "tools:",
    "  - builtin: finish",
    "limits:",
    "  max_steps: 12",
    "  max_tokens: 100000",
    "  max_wall_seconds: 60",
    "  max_usd: 1.0",
  ].join("\n"));
}
function dropProfile(name) {
  try { rmSync(join(dataDir(), "profiles", `${name}.yaml`), { force: true }); } catch { /* ignore */ }
}

function seedRuns(profile, specs) {
  const ids = [];
  for (const s of specs) {
    const id = createRun({ profile, model: "mock/mock", objective: "seed", organism_id: "test" });
    updateRun(id, {
      status: s.status ?? "done",
      stop_reason: s.stop_reason ?? "explicit_final_answer",
      step_count: s.steps ?? 5,
      total_tokens: 100,
      total_cost: s.cost ?? 0.01,
      unverified: s.unverified ? 1 : 0,
      receipt: s.receipt ?? null,
      finished_at: new Date().toISOString(),
    });
    ids.push(id);
  }
  return ids;
}
const driftReceipt = (drift, evidence = []) =>
  JSON.stringify({ drift, evidence });
// Unique profile per test run: runs.db persists across suites, so fixed names
// would see stale history from prior runs.
function uniq(base) {
  return `${base}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

test("analyze: unknown profile errors honestly", () => {
  const r = analyzeProfile("no-such-profile-xyz");
  assert.equal(r.error, "profile_not_found");
});

test("analyze: chronic max_steps suggests raising the ceiling", () => {
  const name = uniq("analyze-maxsteps");
  makeProfile(name);
  try {
    seedRuns(name, [
      { stop_reason: "max_steps", steps: 12, cost: 0.05 },
      { stop_reason: "max_steps", steps: 12, cost: 0.05 },
      { stop_reason: "max_steps", steps: 12, cost: 0.05 },
      { stop_reason: "explicit_final_answer", steps: 4, cost: 0.01 },
    ]);
    const r = analyzeProfile(name, { window: 10 });
    assert.equal(r.runs, 4);
    const s = r.suggestions.find((x) => x.finding === "chronic max_steps");
    assert.ok(s, "max_steps suggestion present");
    assert.ok(s.patch.limits.max_steps > 12, "proposes a higher ceiling");
  } finally { dropProfile(name); }
});

test("analyze: high unverified rate suggests enforce", () => {
  const name = uniq("analyze-unverified");
  makeProfile(name);
  try {
    seedRuns(name, [
      { stop_reason: "explicit_final_answer", unverified: true },
      { stop_reason: "explicit_final_answer", unverified: true },
      { stop_reason: "explicit_final_answer", unverified: false },
    ]);
    const r = analyzeProfile(name, { window: 10 });
    const s = r.suggestions.find((x) => x.finding === "unverified outcomes");
    assert.ok(s, "enforce suggestion present");
    assert.equal(s.patch.policy.verify_before_finish, "enforce");
  } finally { dropProfile(name); }
});

test("analyze: healthy history yields no alarmist patches", () => {
  const name = uniq("analyze-healthy");
  makeProfile(name);
  try {
    seedRuns(name, [
      { stop_reason: "explicit_final_answer", steps: 3, cost: 0.005 },
      { stop_reason: "explicit_final_answer", steps: 4, cost: 0.006 },
      { stop_reason: "explicit_final_answer", steps: 3, cost: 0.005 },
    ]);
    const r = analyzeProfile(name, { window: 10 });
    assert.equal(r.suggestions.length, 0, "no suggestions for a healthy profile");
    assert.ok(r.findings.some((f) => f.metric === "completion_rate"));
  } finally { dropProfile(name); }
});

test("analyze: MCP tool surface works end to end", async () => {
  const name = uniq("analyze-healthy");
  makeProfile(name);
  try {
    seedRuns(name, [{ stop_reason: "explicit_final_answer", steps: 3, cost: 0.005 }]);
    const r = await dispatchCall("ape_agent_analyze", { profile: name, window: 10 });
    assert.equal(r.resultType, "complete");
    assert.equal(r.structuredContent.result.profile, name);
    assert.ok(Array.isArray(r.structuredContent.result.findings));
    const bad = await dispatchCall("ape_agent_analyze", { profile: "nope" });
    assert.equal(bad.structuredContent.result.error, "profile_not_found");
  } finally { dropProfile(name); }
});

test("analyze: max_steps with drift evidence blames trajectory, not budget", () => {
  const name = uniq("analyze-stuck");
  makeProfile(name);
  try {
    seedRuns(name, [
      { stop_reason: "max_steps", steps: 12, cost: 0.05, receipt: driftReceipt({ max_same_tool_streak: 9, warnings: 1, distinct_tools: 1 }) },
      { stop_reason: "max_steps", steps: 12, cost: 0.05, receipt: driftReceipt({ max_same_tool_streak: 7, warnings: 1, distinct_tools: 2 }) },
      { stop_reason: "repetition_detected", steps: 8, cost: 0.03 },
      { stop_reason: "explicit_final_answer", steps: 4, cost: 0.01 },
    ]);
    const r = analyzeProfile(name, { window: 10 });
    const s = r.suggestions.find((x) => x.finding === "chronic max_steps");
    assert.ok(s, "max_steps suggestion present");
    assert.equal(s.patch, null, "no ceiling raise for stuck trajectories");
    assert.ok(s.hypotheses.some((h) => /stuck/.test(h.cause)), "stuck hypothesis ranked");
    assert.ok(["high", "medium"].includes(s.confidence), "confidence stated");
  } finally { dropProfile(name); }
});

test("analyze: max_steps with healthy receipts still earns a raise", () => {
  const name = uniq("analyze-genuine");
  makeProfile(name);
  try {
    seedRuns(name, [
      { stop_reason: "max_steps", steps: 12, cost: 0.05, receipt: driftReceipt({ max_same_tool_streak: 2, warnings: 0, distinct_tools: 4 }, [{ evidence_id: "ev-1" }]) },
      { stop_reason: "max_steps", steps: 12, cost: 0.05, receipt: driftReceipt({ max_same_tool_streak: 3, warnings: 0, distinct_tools: 5 }, [{ evidence_id: "ev-2" }]) },
      { stop_reason: "max_steps", steps: 11, cost: 0.05, receipt: driftReceipt({ max_same_tool_streak: 2, warnings: 0, distinct_tools: 4 }, [{ evidence_id: "ev-3" }]) },
      { stop_reason: "explicit_final_answer", steps: 4, cost: 0.01 },
    ]);
    const r = analyzeProfile(name, { window: 10 });
    const s = r.suggestions.find((x) => x.finding === "chronic max_steps");
    assert.ok(s, "max_steps suggestion present");
    assert.ok(s.patch.limits.max_steps > 12, "genuine multi-step work earns a raise");
    assert.equal(s.confidence, "high", "healthy receipts give high confidence");
  } finally { dropProfile(name); }
});

test("analyze: fallback patch uses a credentialed provider or none", () => {
  const saved = {};
  for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const name = uniq("analyze-fragile");
    makeProfile(name);
    try {
      seedRuns(name, [
        { status: "failed", stop_reason: "model_error" },
        { status: "failed", stop_reason: "no_provider" },
        { stop_reason: "explicit_final_answer", steps: 3 },
      ]);
      const bare = analyzeProfile(name, { window: 10 });
      const s0 = bare.suggestions.find((x) => x.finding === "provider fragility");
      assert.ok(s0, "fragility suggestion present");
      assert.equal(s0.patch, null, "no credential means no patch — decoration refused");
      process.env.OPENROUTER_API_KEY = "test-key";
      const keyed = analyzeProfile(name, { window: 10 });
      const s1 = keyed.suggestions.find((x) => x.finding === "provider fragility");
      assert.equal(s1.patch.model.fallback.provider, "openrouter", "picks the credentialed provider");
      assert.ok(s1.patch.model.fallback.id, "names a model id");
      assert.ok(/NOT assessed|credential present/.test(s1.rationale), "limits of the advice stated");
    } finally { dropProfile(name); }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("analyze: every suggestion carries hypotheses + confidence", () => {
  const name = uniq("analyze-shape");
  makeProfile(name);
  try {
    seedRuns(name, [
      { stop_reason: "max_steps", steps: 12, cost: 0.9 },
      { stop_reason: "max_steps", steps: 12, cost: 0.9 },
      { stop_reason: "repetition_detected", steps: 8, cost: 0.9 },
      { stop_reason: "explicit_final_answer", unverified: true, cost: 0.9 },
      { stop_reason: "explicit_final_answer", unverified: true, cost: 0.9 },
    ]);
    const r = analyzeProfile(name, { window: 10 });
    assert.ok(r.suggestions.length >= 3, "multiple rules fire");
    for (const s of r.suggestions) {
      assert.ok(Array.isArray(s.hypotheses) && s.hypotheses.length > 0, `${s.finding} has hypotheses`);
      assert.ok(s.hypotheses.every((h) => h.cause && h.confidence && Array.isArray(h.evidence)), `${s.finding} hypotheses are structured`);
      assert.ok(["high", "medium", "low"].includes(s.confidence), `${s.finding} states confidence`);
      assert.ok(typeof s.symptom === "string" && typeof s.rationale === "string", `${s.finding} keeps human text`);
    }
  } finally { dropProfile(name); }
});