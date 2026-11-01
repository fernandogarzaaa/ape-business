// CR-1: documented policy/limits keys must survive YAML loading and reach the
// worker/loop. Hand-built test profiles bypass loadProfile, which is exactly
// how the loader silently dropped these controls while the suite stayed green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.APE_DATA_DIR = mkdtempSync(join(tmpdir(), "ape-profiles-"));

const { loadProfile, describeProfile } = await import("../src/agent/profiles.js");
const { runAgent } = await import("../src/agent/loop.js");

function writeYaml(name, body) {
  const dir = join(process.env.APE_DATA_DIR, "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), body);
}
const PROBE = `name: cr1-probe
description: cr1
model: { provider: mock, id: mock-model }
system: test
tools:
  - builtin: memory.recall
  - builtin: finish
limits: { max_steps: 30, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0, max_parallel: 2 }
policy:
  verify_before_finish: off
  parallel_calls: false
  drift: false
  dedup_window_sec: 0
  credential_policy: { allow: [mock], max_spend_usd: { mock: 5 } }
`;
const CAPPED = `name: cr1-capped
description: cr1
model: { provider: mock, id: mock-model }
system: test
tools:
  - builtin: finish
limits: { max_steps: 5, max_tokens: 100000, max_wall_seconds: 60, max_usd: 1.0 }
policy:
  verify_before_finish: off
  credential_policy: { max_spend_usd: { mock: 0 } }
`;
const GARBAGE = `name: cr1-garbage
description: cr1
model: { provider: mock, id: mock-model }
system: test
tools:
  - builtin: finish
limits: { max_steps: 5, max_tokens: 100000, max_wall_seconds: 60, max_usd: lots }
policy:
  credential_policy: { allow: nope, max_spend_usd: { mock: -3 } }
  drift: yes
  dedup_window_sec: -5
`;

test("profiles: YAML preserves every documented control key", () => {
  writeYaml("cr1-probe", PROBE);
  const p = loadProfile("cr1-probe");
  assert.equal(p.policy.parallel_calls, false, "parallel toggle preserved");
  assert.equal(p.policy.drift, false, "drift opt-out preserved");
  assert.equal(p.policy.dedup_window_sec, 0, "dedup window preserved (0 = off)");
  assert.deepEqual(p.policy.credential_policy.allow, ["mock"], "allow-list preserved");
  assert.deepEqual(p.policy.credential_policy.max_spend_usd, { mock: 5 }, "spend caps preserved");
  assert.equal(p.limits.max_parallel, 2, "max_parallel preserved");
  assert.ok(describeProfile("cr1-probe").policy.credential_policy, "describe exposes policy");
});

test("profiles: invalid values fall back safely, never to open/unlimited", () => {
  writeYaml("cr1-garbage", GARBAGE);
  const p = loadProfile("cr1-garbage");
  assert.equal(p.limits.max_usd, 0.5, "non-numeric budget falls back to default, not unlimited");
  assert.equal(p.policy.credential_policy, undefined, "malformed credential policy dropped (absent = restrictive default downstream)");
  assert.equal(p.policy.drift, undefined, "malformed drift dropped");
  assert.equal(p.policy.dedup_window_sec, undefined, "negative window dropped");
});

test("profiles: loaded controls reach the loop (parallel off, drift off)", async () => {
  writeYaml("cr1-probe", PROBE);
  const profile = loadProfile("cr1-probe");
  const script = Array.from({ length: 7 }, (_, i) => ({ tool: "memory.recall", args: { query: `w-${i}` } }));
  script.push({ tool: "finish", args: { summary: "done" } });
  const res = await runAgent({ profile, objective: "cr1 loop", mockScript: script });
  assert.equal(res.stop_reason, "explicit_final_answer");
  assert.ok(!res.steps.some((s) => s.parallel === true), "parallel_calls:false honored from YAML");
  assert.equal(res.receipt.drift.warnings, 0, "drift:false honored from YAML (7-streak, no advisory)");
  assert.equal(res.receipt.drift.max_same_tool_streak, 7, "streak still observed, just not warned");
});

test("profiles: loaded spend caps halt the loop from YAML", async () => {
  writeYaml("cr1-capped", CAPPED);
  const profile = loadProfile("cr1-capped");
  assert.deepEqual(profile.policy.credential_policy.max_spend_usd, { mock: 0 });
  const res = await runAgent({
    profile, objective: "cr1 cap", mockScript: [{ tool: "finish", args: { summary: "never" } }], mockCostPerCall: 0.01,
  });
  assert.equal(res.stop_reason, "spend_capped", "zero cap from YAML serves nothing");
});

test("profiles: absent keys stay absent (defaults apply downstream)", () => {
  const p = loadProfile("repo-triage");
  assert.ok(p, "bundled profile loads");
  assert.equal(p.policy.credential_policy, undefined);
  assert.equal(p.policy.parallel_calls, undefined);
  assert.equal(p.policy.drift, undefined);
  assert.equal(p.policy.dedup_window_sec, undefined);
  assert.equal(p.limits.max_parallel, undefined);
});

test("profiles: L1 specialists load with their engine compositions", () => {
  const deep = loadProfile("deep-researcher");
  assert.ok(deep.tools.some((t) => t.connector === "web"), "research needs the web");
  assert.ok(deep.tools.some((t) => t.engine === "genesis.audit_claim"), "research ends in audit");
  assert.equal(deep.policy.verify_before_finish, "enforce", "research claims are gated");
  const reviewer = loadProfile("code-reviewer");
  assert.ok(reviewer.tools.some((t) => t.engine === "genesis.audit_claim"));
  assert.equal(reviewer.policy.verify_before_finish, "enforce");
  assert.ok(
    reviewer.system.includes("no repository access"),
    "reviewer is honest about having no repo access"
  );
  const lead = loadProfile("triage-lead");
  assert.ok(lead.tools.some((t) => t.engine === "skein.orchestrate"), "lead decomposes via graph");
  const planner = loadProfile("planner");
  assert.ok(planner.tools.some((t) => t.engine === "skein.orchestrate"));
  assert.ok(!planner.tools.some((t) => t.engine === "genesis.audit_claim"), "planner never audits (never executes)");
  assert.ok(planner.limits.max_usd <= 0.3 && planner.limits.max_steps <= 8, "planners stay cheap");
});

test("profiles: loaded enforce policy engages in the loop from YAML", async () => {
  const profile = loadProfile("deep-researcher");
  const res = await runAgent({
    profile,
    objective: "L1 enforce smoke",
    mockScript: [{ tool: "finish", args: { summary: "no evidence" } }],
    resolvedModel: { provider: "mock", id: "mock-model" },
  });
  assert.notEqual(res.stop_reason, "explicit_final_answer", "finish rejected without audit evidence");
  assert.ok(res.steps.some((s) => String(s.resultSummary).includes("finish:rejected")));
});

test("profiles: loaded triage-lead finishes a mock smoke run", async () => {
  const profile = loadProfile("triage-lead");
  const res = await runAgent({
    profile,
    objective: "L1 smoke",
    mockScript: [{ tool: "finish", args: { summary: "synthesis" } }],
    resolvedModel: { provider: "mock", id: "mock-model" },
  });
  assert.equal(res.stop_reason, "explicit_final_answer");
  assert.ok(res.receipt, "receipt present");
});
