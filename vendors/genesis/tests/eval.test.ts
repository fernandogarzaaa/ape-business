/**
 * Unit tests for the universal evaluation platform.
 * Pure modules only — no better-sqlite3, no network, no randomness in asserts.
 */

import { describe, expect, it } from "vitest";

import { validateClaim, checkHypothesis } from "../src/eval/claim.js";
import { parseSpec } from "../src/eval/spec.js";
import { fromRecords, loadDataset } from "../src/eval/dataset.js";
import { createEvaluator } from "../src/eval/evaluators.js";
import { createSubject } from "../src/eval/subjects.js";
import { computeMetric, classificationMetrics, metricNames } from "../src/eval/metrics.js";
import { describe as describeStats, describeRate, pairedCompare, parseThreshold, checkThreshold, bootstrapMeanCI } from "../src/eval/stats.js";
import { decideVerdict } from "../src/eval/verdict.js";
import { runExperiment } from "../src/eval/runner.js";
import { buildManifest, writeEvidenceBundle } from "../src/eval/bundle.js";
import { renderReport } from "../src/eval/report.js";
import { compareBundles, checkRegression } from "../src/eval/compare.js";
import type { EvalTask } from "../src/eval/types.js";

function task(overrides: Partial<EvalTask> = {}): EvalTask {
  return { id: "task-0001", input: "hello", reference: "HELLO", ...overrides };
}

// ── claims ──

describe("claims", () => {
  it("validates a well-formed claim", () => {
    const { claim, problems } = validateClaim({
      id: "claim-001",
      statement: "System A maintains >=95% task success.",
      hypothesis: { primary: { metric: "task_success", operator: ">=", threshold: 0.95 } },
      methodology: { paired: true, repetitions: 3, minimum_samples: 200 },
    });
    expect(problems).toEqual([]);
    expect(claim.id).toBe("claim-001");
    expect(claim.hypothesis?.primary.threshold).toBe(0.95);
  });

  it("rejects missing id/statement and bad operators", () => {
    const { problems } = validateClaim({
      statement: "",
      hypothesis: { primary: { metric: "x", operator: "~=", threshold: NaN } },
    });
    expect(problems.length).toBeGreaterThan(0);
  });

  it("checks hypotheses per operator", () => {
    expect(checkHypothesis({ metric: "m", operator: ">=", threshold: 0.9 }, 0.9)).toBe(true);
    expect(checkHypothesis({ metric: "m", operator: ">=", threshold: 0.9 }, 0.89)).toBe(false);
    expect(checkHypothesis({ metric: "m", operator: "<", threshold: 100 }, 100)).toBe(false);
    expect(checkHypothesis({ metric: "m", operator: "!=", threshold: 1 }, 1)).toBe(false);
    expect(checkHypothesis({ metric: "m", operator: ">=", threshold: 0.9 }, null)).toBeNull();
  });
});

// ── spec ──

describe("spec", () => {
  it("parses a YAML evaluation spec", () => {
    const spec = parseSpec(`
name: demo
dataset:
  path: ./cases.jsonl
subject:
  command: "python agent.py {task_file}"
evaluator:
  type: exact
metrics:
  - task_success
repetitions: 3
`, "test");
    expect(spec.name).toBe("demo");
    expect(spec.subject?.command).toBe("python agent.py {task_file}");
    expect(spec.repetitions).toBe(3);
  });

  it("parses JSON specs and inline claims", () => {
    const spec = parseSpec(JSON.stringify({
      name: "j",
      dataset: { inline: [{ input: "a" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      claim: { id: "c1", statement: "upper works" },
    }));
    expect(spec.claim?.id).toBe("c1");
  });

  it("rejects specs without subject/evaluator", () => {
    expect(() => parseSpec(JSON.stringify({ name: "bad" }))).toThrow();
  });
});

// ── datasets ──

describe("datasets", () => {
  it("normalizes records and digests deterministically", () => {
    const a = fromRecords([{ input: "x", reference: "y" }], "d", "1");
    const b = fromRecords([{ reference: "y", input: "x" }], "d", "1");
    expect(a.info.digest).toBe(b.info.digest);
    expect(a.info.task_count).toBe(1);
    expect(a.tasks[0]?.id).toBe("task-0001");
  });

  it("loads jsonl, csv, and text", () => {
    const jsonl = loadDataset({ stdin: '{"input":"a"}\n{"input":"b"}', format: "jsonl", id: "j" });
    expect(jsonl.tasks).toHaveLength(2);
    const csv = loadDataset({ stdin: "input,reference\na,1\nb,2", format: "csv", id: "c" });
    expect(csv.tasks).toHaveLength(2);
    expect(csv.tasks[0]?.input).toBe("a");
    const text = loadDataset({ stdin: "one\ntwo\n", format: "text", id: "t" });
    expect(text.tasks).toHaveLength(2);
  });

  it("requires a source", () => {
    expect(() => loadDataset({})).toThrow();
  });
});

// ── subjects ──

describe("subjects", () => {
  it("runs inline transforms", async () => {
    const upper = createSubject({ inline: "upper" });
    const r = await upper.run(task({ input: "hello" }), 0, null);
    expect(r.output).toBe("HELLO");
    expect(r.error).toBeNull();
  });

  it("rejects unknown inline kinds without throwing", async () => {
    const s = createSubject({ inline: "nope" });
    const r = await s.run(task(), 0, null);
    expect(r.error).toContain("unknown inline");
  });

  it("runs command subjects against fixtures", async () => {
    const s = createSubject({ command: "node ./examples/arithmetic/candidate.mjs {task_file}" });
    const r = await s.run(task({ input: "21" }), 0, null);
    expect(String(r.output)).toBe("42");
  });
});

// ── evaluators ──

describe("evaluators", () => {
  it("exact matches references", async () => {
    const e = createEvaluator({ type: "exact" });
    expect((await e.evaluate(task({ input: "x", reference: "HELLO" }), "HELLO")).passed).toBe(true);
    expect((await e.evaluate(task({ input: "x", reference: "HELLO" }), "bye")).passed).toBe(false);
  });

  it("exact abstains without a reference instead of matching 'undefined'", async () => {
    const e = createEvaluator({ type: "exact" });
    // P1: norm(undefined) is the string "undefined" — a subject emitting it
    // must never pass.
    const r = await e.evaluate(task({ input: "x", reference: undefined }), "undefined");
    expect(r.passed).toBeNull();
    expect(r.score).toBeNull();
  });

  it("regex tests patterns", async () => {
    const e = createEvaluator({ type: "regex", pattern: "^OK:" });
    expect((await e.evaluate(task(), "OK: done")).passed).toBe(true);
    expect((await e.evaluate(task(), "FAIL")).passed).toBe(false);
  });

  it("json_schema validates structure", async () => {
    const e = createEvaluator({
      type: "json_schema",
      schema: { type: "object", required: ["a"], properties: { a: { type: "number" } } },
    });
    expect((await e.evaluate(task(), { a: 1 })).passed).toBe(true);
    expect((await e.evaluate(task(), { b: 2 })).passed).toBe(false);
    expect((await e.evaluate(task(), "not json")).passed).toBe(false);
  });

  it("javascript runs predicates", async () => {
    const e = createEvaluator({ type: "javascript", script: "return output === task.reference;" });
    expect((await e.evaluate(task({ reference: 1 }), 1)).passed).toBe(true);
  });

  it("composite combines sub-evaluators", async () => {
    const e = createEvaluator({
      type: "composite",
      mode: "all",
      evaluators: [{ type: "regex", pattern: "a" }, { type: "regex", pattern: "b" }],
    });
    expect((await e.evaluate(task(), "abc")).passed).toBe(true);
    expect((await e.evaluate(task(), "axc")).passed).toBe(false);
  });

  it("human imports judgments from jsonl", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "genesis-test-"));
    try {
      const p = join(dir, "j.jsonl");
      writeFileSync(p, '{"task_id":"task-0001","passed":true}\n', "utf8");
      const e = createEvaluator({ type: "human", judgments: p });
      expect((await e.evaluate(task(), "anything")).passed).toBe(true);
      expect((await e.evaluate(task({ id: "task-9999" }), "anything")).passed).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── metrics ──

describe("metrics", () => {
  it("registers the expected built-ins", () => {
    expect(metricNames()).toContain("task_success");
    expect(metricNames()).toContain("p95_latency_ms");
    expect(metricNames()).toContain("cost_per_success_usd");
  });

  it("computes task_success and latency", () => {    const trials = [
      { trial_id: "t1", task_id: "a", repetition: 1, seed: 1, subject: "s", started_at: "", ended_at: "", duration_ms: 100, timed_out: false, error: null, output: "x" },
      { trial_id: "t2", task_id: "b", repetition: 1, seed: 1, subject: "s", started_at: "", ended_at: "", duration_ms: 300, timed_out: false, error: null, output: "y" },
    ] as never;
    const observations = [
      { trial_id: "t1", task_id: "a", evaluator: "e", evaluator_kind: "reference", score: 1, passed: true },
      { trial_id: "t2", task_id: "b", evaluator: "e", evaluator_kind: "reference", score: 0, passed: false },
    ] as never;
    expect(computeMetric("task_success", { trials, observations }).value).toBe(0.5);
    expect(computeMetric("p95_latency_ms", { trials, observations }).value).toBeGreaterThan(100);
    expect(computeMetric("timeout_rate", { trials, observations }).value).toBe(0);
  });

  it("P1: unjudged trials count against success rates (fail-closed denominator)", () => {
    const trials = [
      { trial_id: "t1", task_id: "a", repetition: 1, seed: 1, subject: "s", started_at: "", ended_at: "", duration_ms: 10, timed_out: false, error: null, output: "x" },
    ] as never;
    const mk = (passed: boolean | null, score: number | null) => ({
      trial_id: "t1", task_id: "a", evaluator: "e", evaluator_kind: "reference", score, passed,
    });
    // 1 accept + 7 abstentions over 8 observations reads 0.125, not 1.0.
    const observations = [mk(true, 1), mk(null, null), mk(null, null), mk(null, null), mk(null, null), mk(null, null), mk(null, null), mk(null, null)] as never;
    expect(computeMetric("task_success", { trials, observations }).value).toBe(0.125);
    expect(computeMetric("accuracy", { trials, observations }).value).toBe(0.125);
    expect(computeMetric("failure_rate", { trials, observations }).value).toBe(0.875);
    expect(computeMetric("exact_match", { trials, observations }).value).toBe(0.125);
  });

  it("returns null on missing data instead of throwing", () => {
    expect(computeMetric("task_success", { trials: [], observations: [] }).value).toBeNull();
  });

  it("computes classification metrics", () => {
    const m = classificationMetrics([
      { predicted: true, actual: true },
      { predicted: true, actual: false },
      { predicted: false, actual: false },
    ]);
    expect(m.accuracy).toBeCloseTo(2 / 3);
    expect(m.precision).toBe(0.5);
    expect(m.recall).toBe(1);
  });
});

// ── stats ──

describe("statistics", () => {
  it("describes samples with bootstrap CIs", () => {
    const s = describeStats([1, 1, 1, 1, 0, 0, 0, 0], "task_success");
    expect(s?.mean).toBe(0.5);
    expect(s?.ci95.low).toBeLessThanOrEqual(s?.ci95.high ?? 1);
    expect(s?.assumptions.length).toBeGreaterThan(0);
  });

  it("uses Wilson intervals for rates", () => {
    const s = describeRate(8, 8, "task_success");
    expect(s?.mean).toBe(1);
    expect(s?.ci95.low).toBeLessThan(1);
  });

  it("bootstrap is reproducible", () => {
    const a = bootstrapMeanCI([1, 2, 3, 4], 500, 0.95, 42);
    const b = bootstrapMeanCI([1, 2, 3, 4], 500, 0.95, 42);
    expect(a).toEqual(b);
  });

  it("compares paired arms without claiming significance", () => {
    const c = pairedCompare({ a: 0, b: 0 }, { a: 1, b: 1 }, "task_success");
    expect(c?.delta).toBe(1);
    expect(c?.n_pairs).toBe(2);
    expect(c?.method).toContain("paired");
    expect(pairedCompare({}, {}, "m")).toBeNull();
  });

  it("parses threshold expressions", () => {
    expect(parseThreshold(">=0.90")).toEqual({ op: ">=", value: 0.9 });
    expect(parseThreshold("nonsense")).toBeNull();
    expect(checkThreshold(0.95, ">=0.90")).toBe(true);
    expect(checkThreshold(null, ">=0.90")).toBeNull();
  });
});

// ── verdicts ──

describe("verdicts", () => {
  const base = {
    datasetLabel: "d@1",
    datasetDigest: "sha256:x",
    sampleSize: 8,
    repetitions: 1,
    conditions: {},
  };
  it("supports satisfied hypotheses", () => {
    const v = decideVerdict({
      ...base,
      claim: {
        id: "c", statement: "s", status: "UNTESTED",
        hypothesis: { primary: { metric: "task_success", operator: ">=", threshold: 0.875 } },
      },
      metrics: [{ metric: "task_success", value: 1, n: 8 }],
    });
    expect(v.verdict).toBe("SUPPORTED");
    expect(v.scope.not_tested).toContain("not established");
  });

  it("falsifies failed hypotheses", () => {
    const v = decideVerdict({
      ...base,
      claim: {
        id: "c", statement: "s", status: "UNTESTED",
        hypothesis: { primary: { metric: "task_success", operator: ">=", threshold: 0.875 } },
      },
      metrics: [{ metric: "task_success", value: 0.125, n: 8 }],
    });
    expect(v.verdict).toBe("FALSIFIED");
  });

  it("is INCONCLUSIVE on missing evidence or unmet minimum samples", () => {
    expect(decideVerdict({ ...base, sampleSize: 0, metrics: [] }).verdict).toBe("INCONCLUSIVE");
    expect(decideVerdict({
      ...base,
      sampleSize: 2,
      claim: {
        id: "c", statement: "s", status: "UNTESTED",
        hypothesis: { primary: { metric: "task_success", operator: ">=", threshold: 0.5 } },
        methodology: { minimum_samples: 200 },
      },
      metrics: [{ metric: "task_success", value: 1, n: 2 }],
    }).verdict).toBe("INCONCLUSIVE");
  });
});

// ── runner end-to-end (local, deterministic, no network) ──

describe("experiment runner", () => {
  it("runs dataset → subject → evaluator → verdict with repetitions", async () => {
    const result = await runExperiment({
      name: "upper-test",
      dataset: { inline: [{ id: "a", input: "hi", reference: "HI" }, { id: "b", input: "yo", reference: "YO" }] },
      subject: { name: "upper", inline: "upper" },
      baseline: { name: "echo", inline: "echo" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
      repetitions: 2,
      thresholds: { task_success: ">=0.9" },
    });
    expect(result.arms).toHaveLength(2);
    expect(result.arms[0]?.trials).toHaveLength(4);
    expect(result.verdict.verdict).toBe("SUPPORTED");
    expect(result.comparisons.length).toBeGreaterThan(0);
    expect(result.findings.length).toBeGreaterThan(0); // baseline fails → finding
    const allEvidence = result.arms.flatMap((a) => a.evidence);
    expect(allEvidence.length).toBe(8); // 2 tasks × 2 reps × 2 arms
    const digests = allEvidence.map((e) => e.digest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("marks evaluator gaps when judgments are missing", async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "genesis-test-"));
    try {
      const p = join(dir, "empty.jsonl");
      writeFileSync(p, "", "utf8");
      const result = await runExperiment({
        name: "gap",
        dataset: { inline: [{ input: "x" }] },
        subject: { inline: "echo" },
        evaluator: { type: "human", judgments: p },
        metrics: ["task_success"],
      });
      expect(result.findings.some((f) => f.category === "evaluator-gap")).toBe(true);
      expect(result.verdict.verdict).toBe("INCONCLUSIVE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── bundle / report / compare / regression ──

describe("evidence bundle", () => {
  it("writes a complete traceable bundle", async () => {
    const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const result = await runExperiment({
      name: "bundle-test",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
    });
    const dir = mkdtempSync(join(tmpdir(), "genesis-bundle-"));
    try {
      const manifest = buildManifest({ name: "bundle-test", dataset: {}, subject: { inline: "upper" }, evaluator: { type: "exact" } }, result);
      writeEvidenceBundle(dir, { name: "t", dataset: {}, subject: { inline: "upper" }, evaluator: { type: "exact" } }, result, manifest);
      expect(existsSync(join(dir, "verdict.json"))).toBe(true);
      expect(existsSync(join(dir, "manifest.json"))).toBe(true);
      expect(existsSync(join(dir, "treatment", "results.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "evidence", "evidence.jsonl"))).toBe(true);
      const report = renderReport(result);
      expect(report).toContain("VERDICT");
      expect(report).toContain("EVALUATOR TRUST");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compares bundles and gates regressions", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const mk = async (subject: "upper" | "echo", dir: string) => {
      const result = await runExperiment({
        name: "t",
        dataset: { inline: [{ input: "a", reference: "A" }, { input: "b", reference: "B" }] },
        subject: { inline: subject },
        evaluator: { type: "exact" },
        metrics: ["task_success"],
      });
      const manifest = buildManifest({ name: "t", dataset: {}, subject: { inline: subject }, evaluator: { type: "exact" } }, result);
      writeEvidenceBundle(dir, { name: "t", dataset: {}, subject: { inline: subject }, evaluator: { type: "exact" } }, result, manifest);
    };
    const good = mkdtempSync(join(tmpdir(), "genesis-good-"));
    const bad = mkdtempSync(join(tmpdir(), "genesis-bad-"));
    try {
      await mk("upper", good);
      await mk("echo", bad);
      const { deltas } = compareBundles(good, bad);
      expect(deltas.find((d) => d.metric === "task_success")?.delta).toBeLessThan(0);
      // Candidate=good vs base=bad passes; candidate=bad vs base=good fails.
      expect(checkRegression(bad, good, { quality: { max_drop: 0.02 } }).pass).toBe(true);
      expect(checkRegression(good, bad, { quality: { max_drop: 0.02 } }).pass).toBe(false);
    } finally {
      rmSync(good, { recursive: true, force: true });
      rmSync(bad, { recursive: true, force: true });
    }
  });
});

// ── adversarial robustness of the evaluation loop ──

describe("adversarial evaluation", () => {
  it("subject timeout is recorded, not fatal", async () => {
    const result = await runExperiment({
      name: "timeout",
      dataset: { inline: [{ input: "x", reference: "x" }] },
      subject: { inline: "echo", timeout_ms: 1 },
      evaluator: { type: "exact" },
      metrics: ["task_success", "timeout_rate"],
    });
    expect(result.arms[0]?.trials).toHaveLength(1);
    expect(result.verdict.verdict).toMatch(/SUPPORTED|FALSIFIED|INCONCLUSIVE/);
  });

  it("corrupted thresholds do not produce false SUPPORTED", async () => {
    const result = await runExperiment({
      name: "corr",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { inline: "upper" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
      thresholds: { task_success: "not-a-threshold" },
    });
    expect(result.verdict.verdict).not.toBe("SUPPORTED");
  });

  it("unknown metrics never silently pass", async () => {
    const result = await runExperiment({
      name: "unk",
      dataset: { inline: [{ input: "a" }] },
      subject: { inline: "echo" },
      evaluator: { type: "pass_through" },
      metrics: ["nonexistent_metric_xyz"],
    });
    expect(result.verdict.verdict).toBe("INCONCLUSIVE");
  });
});
