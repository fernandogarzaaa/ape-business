/**
 * Milestone 2: classification labels wiring + RAG/retrieval metrics.
 * Pure unit tests plus end-to-end runs of the deterministic local examples.
 */

import { describe, expect, it } from "vitest";

import { createEvaluator } from "../src/eval/evaluators.js";
import {
  computeMetric, classificationMetrics, rocAuc, prAuc,
  expectedCalibrationError, retrievalF1, retrievalTrialStats,
} from "../src/eval/metrics.js";
import { runExperiment } from "../src/eval/runner.js";
import { loadSpecFile } from "../src/eval/spec.js";
import type { EvalTask } from "../src/eval/types.js";

function clfTask(reference: string): EvalTask {
  return { id: "t1", input: "x", reference };
}

// ── classification evaluator ──

describe("classification evaluator", () => {
  it("resolves binary pairs against a declared positive class", async () => {
    const e = createEvaluator({ type: "classification", positive: "positive", scoreField: "score" });
    const hit = await e.evaluate(clfTask("positive"), { label: "positive", score: 0.9 });
    expect(hit.passed).toBe(true);
    expect(hit.details).toMatchObject({ predicted_bool: true, actual_bool: true, score: 0.9 });

    const miss = await e.evaluate(clfTask("negative"), { label: "positive", score: 0.9 });
    expect(miss.passed).toBe(false);
    expect(miss.details).toMatchObject({ predicted_bool: true, actual_bool: false });
  });

  it("accepts raw string outputs and boolean actuals without a declared positive", async () => {
    const e = createEvaluator({ type: "classification" });
    const r = await e.evaluate({ id: "t", input: "x", reference: true }, true);
    expect(r.passed).toBe(true);
    expect(r.details).toMatchObject({ predicted_bool: true, actual_bool: true });
  });

  it("records raw labels but no booleans for multiclass without a positive class", async () => {
    const e = createEvaluator({ type: "classification" });
    const r = await e.evaluate(clfTask("cat"), "dog");
    expect(r.passed).toBe(false);
    expect(r.details).toMatchObject({ predicted: "dog", actual: "cat" });
    expect(r.details).not.toHaveProperty("predicted_bool");
  });

  it("P1: classification abstains without ground truth instead of matching 'null'", async () => {
    const e = createEvaluator({ type: "classification", positive: "positive" });
    const r = await e.evaluate({ id: "t", input: "x" }, "null");
    expect(r.passed).toBeNull();
    expect(r.score).toBeNull();
  });
});

// ── retrieval evaluator ──

describe("retrieval evaluator", () => {
  const task: EvalTask = {
    id: "t1", input: "q", metadata: { relevant_ids: ["a", "b"] },
  };
  it("scores partial retrieval with F1", async () => {
    const e = createEvaluator({ type: "retrieval" });
    const r = await e.evaluate(task, { retrieved_ids: ["a", "c"] });
    expect(r.details).toMatchObject({ precision: 0.5, recall: 0.5 });
    expect(r.score).toBeCloseTo(0.5);
    expect(r.passed).toBe(true); // F1 >= 0.5
  });

  it("scores disjoint retrieval as 0, not null", async () => {
    const e = createEvaluator({ type: "retrieval" });
    const r = await e.evaluate(task, { retrieved_ids: ["x"] });
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("returns nulls when ids are missing, and accepts bare arrays", async () => {
    const e = createEvaluator({ type: "retrieval" });
    const missing = await e.evaluate({ id: "t", input: "q" }, { retrieved_ids: ["a"] });
    expect(missing.score).toBeNull();
    const bare = await e.evaluate(task, ["a", "b"]);
    expect(bare.score).toBe(1);
  });
});

// ── classification metrics ──

describe("classification metrics", () => {
  it("precision/recall/f1 aggregate boolean pairs", () => {
    const m = classificationMetrics([
      { predicted: true, actual: true },
      { predicted: true, actual: false },
      { predicted: false, actual: false },
      { predicted: false, actual: true },
    ]);
    expect(m.precision).toBe(0.5);
    expect(m.recall).toBe(0.5);
    expect(m.f1).toBe(0.5);
    expect(m.accuracy).toBe(0.5);
  });

  it("degenerate predictions yield null, not misleading zeroes", () => {
    // Never predicts positive: precision undefined, recall 0.
    const m = classificationMetrics([
      { predicted: false, actual: true },
      { predicted: false, actual: false },
    ]);
    expect(m.precision).toBeNull();
    expect(m.recall).toBe(0);
    expect(m.f1).toBeNull();
  });

  it("roc_auc ranks perfectly separated scores as 1", () => {
    expect(rocAuc([
      { score: 0.9, actual: true }, { score: 0.8, actual: true },
      { score: 0.2, actual: false }, { score: 0.1, actual: false },
    ])).toBe(1);
  });

  it("roc_auc is 0.5 for tied scores and null for single-class data", () => {
    expect(rocAuc([
      { score: 0.99, actual: true }, { score: 0.99, actual: false },
    ])).toBe(0.5);
    expect(rocAuc([{ score: 0.9, actual: true }])).toBeNull();
    expect(rocAuc([])).toBeNull();
  });

  it("pr_auc is average precision", () => {
    // Ranked: T, F, T → AP = (1/1 + 2/3)/2 = 5/6.
    expect(prAuc([
      { score: 0.9, actual: true }, { score: 0.5, actual: false }, { score: 0.4, actual: true },
    ])).toBeCloseTo(5 / 6);
    expect(prAuc([{ score: 0.1, actual: false }])).toBeNull();
  });

  it("perfect calibration has ECE 0; overconfidence is penalized", () => {
    expect(expectedCalibrationError([
      { score: 1, actual: true }, { score: 0, actual: false },
    ])).toBe(0);
    const ece = expectedCalibrationError([
      { score: 0.9, actual: true }, { score: 0.9, actual: false },
      { score: 0.1, actual: false }, { score: 0.1, actual: false },
    ]);
    expect(ece).toBeCloseTo(0.5 * Math.abs(0.5 - 0.9) + 0.5 * Math.abs(0 - 0.1));
  });
});

// ── retrieval + detail metrics through the registry ──

describe("retrieval metrics", () => {
  function obs(retrieved: string[] | null, relevant: string[] | null) {
    return {
      trial_id: "t", task_id: "a", evaluator: "retrieval", evaluator_kind: "reference",
      score: 0, passed: false,
      details: { retrieved_ids: retrieved, relevant_ids: relevant },
    } as never;
  }
  const input = {
    trials: [],
    observations: [
      obs(["a", "c"], ["a", "b"]), // P .5 R .5
      obs(["a", "b"], ["a", "b"]), // P 1 R 1
      obs(["x"], ["a", "b"]),      // P 0 R 0
    ],
  } as never;

  it("averages per-trial precision/recall/f1 over defined trials", () => {
    expect(computeMetric("retrieval_precision", input).value).toBeCloseTo(0.5);
    expect(computeMetric("retrieval_recall", input).value).toBeCloseTo(0.5);
    expect(computeMetric("retrieval_f1", input).value).toBeCloseTo((0.5 + 1 + 0) / 3);
    expect(computeMetric("context_relevance", input).value).toBeCloseTo(0.5);
  });

  it("malformed retrieval counts as 0; only gold-missing trials are excluded", () => {
    const withMalformed = {
      trials: [],
      observations: [...(input as { observations: never[] }).observations, obs(null, ["a"])],
    } as never;
    // null retrieved + present gold is a judged failure: (0.5+1+0+0)/4.
    expect(computeMetric("retrieval_precision", withMalformed).value).toBeCloseTo(0.375);
    const withGoldMissing = {
      trials: [],
      observations: [...(input as { observations: never[] }).observations, obs(["a"], null)],
    } as never;
    // No gold: excluded, mean unchanged at 0.5.
    expect(computeMetric("retrieval_precision", withGoldMissing).value).toBeCloseTo(0.5);
  });

  it("P1: duplicated IDs are de-duplicated before scoring", () => {
    // ["a","a"] vs ["a"] used to report recall 2 and F1 4/3.
    const s = retrievalTrialStats(["a", "a"], ["a"]);
    expect(s).toMatchObject({ judged: true, p: 1, r: 1, f1: 1 });
    const e = createEvaluator({ type: "retrieval" });
    return e.evaluate(
      { id: "t", input: "q", metadata: { relevant_ids: ["a"] } },
      { retrieved_ids: ["a", "a", "b"] },
    ).then((r) => {
      expect(r.score).toBeCloseTo(2 / 3);
      expect(r.details).toMatchObject({ precision: 0.5, recall: 1 });
    });
  });

  it("P1: empty or malformed retrieval scores 0; missing gold is unjudged", () => {
    expect(retrievalTrialStats([], ["a", "b"])).toMatchObject({ judged: true, p: 0, r: 0, f1: 0 });
    expect(retrievalTrialStats(null, ["a"])).toMatchObject({ judged: true, p: 0, r: 0, f1: 0 });
    expect(retrievalTrialStats(["a"], null)).toMatchObject({ judged: false, p: null, r: null });
    expect(retrievalTrialStats(["a"], [])).toMatchObject({ judged: false, p: null, r: null });
    expect(retrievalF1(1, 1)).toBe(1);
  });
});

describe("detail metrics", () => {
  it("detail:<field> averages numeric details; faithfulness/answer_correctness wire through", () => {
    const input = {
      trials: [],
      observations: [
        { trial_id: "a", task_id: "a", evaluator: "llm", evaluator_kind: "llm", score: 0.8, passed: true, details: { faithfulness: 0.8, answer_correctness: 0.6 } },
        { trial_id: "b", task_id: "b", evaluator: "llm", evaluator_kind: "llm", score: 0.4, passed: false, details: { faithfulness: 0.4 } },
      ],
    } as never;
    expect(computeMetric("detail:faithfulness", input).value).toBeCloseTo(0.6);
    expect(computeMetric("faithfulness", input).value).toBeCloseTo(0.6);
    expect(computeMetric("answer_correctness", input).value).toBeCloseTo(0.6);
    expect(computeMetric("detail:missing", input).value).toBeNull();
  });
});

// ── end to end: the shipped examples ──

describe("example evaluations", () => {
  it("rag: keyword retriever beats the static baseline", async () => {
    const spec = loadSpecFile("examples/rag/evaluation.yaml");
    const result = await runExperiment(spec);
    const get = (arm: string, metric: string) =>
      result.arms.find((a) => a.arm === arm)?.metrics.find((m) => m.metric === metric)?.value ?? null;
    expect(get("treatment", "retrieval_recall")).toBeGreaterThanOrEqual(0.75);
    expect(get("baseline", "retrieval_recall")).toBe(0);
    expect(result.verdict.verdict).toBe("SUPPORTED");
    // Statistics agree with the reported points (no score/metric mixups).
    for (const arm of result.arms) {
      for (const m of arm.metrics) {
        const stat = arm.statistics.find((s) => s?.metric === m.metric);
        if (stat) expect(stat.mean).toBeCloseTo(m.value, 4);
      }
    }
    const comp = result.comparisons.find((c) => c.metric.startsWith("retrieval_recall"));
    expect(comp?.treatment_mean).toBeCloseTo(get("treatment", "retrieval_recall") ?? NaN, 4);
  }, 120_000);

  it("classification: keyword classifier is accurate and calibrated", async () => {
    const spec = loadSpecFile("examples/classification/evaluation.yaml");
    const result = await runExperiment(spec);
    const get = (arm: string, metric: string) =>
      result.arms.find((a) => a.arm === arm)?.metrics.find((m) => m.metric === metric)?.value ?? null;
    expect(get("treatment", "accuracy")).toBe(1);
    expect(get("treatment", "f1")).toBe(1);
    expect(get("treatment", "roc_auc")).toBe(1);
    expect(get("treatment", "calibration_ece")).toBeLessThanOrEqual(0.2);
    expect(get("baseline", "accuracy")).toBe(0.5);
    expect(get("baseline", "roc_auc")).toBe(0.5);
    expect(result.verdict.verdict).toBe("SUPPORTED");
  }, 120_000);

  it("multiclass without a positive class keeps accuracy, nulls binary rates", async () => {
    const result = await runExperiment({
      name: "multiclass",
      dataset: { inline: [{ input: "x", reference: "cat" }, { input: "y", reference: "dog" }] },
      subject: { inline: "echo" },
      evaluator: { type: "classification" },
      metrics: ["accuracy", "precision", "recall", "f1"],
    });
    const get = (metric: string) => result.arms[0]?.metrics.find((m) => m.metric === metric)?.value ?? null;
    // echo returns the input, not the label → accuracy 0, and binary rates null (honest, not 0).
    expect(get("accuracy")).toBe(0);
    expect(result.arms[0]?.metrics.find((m) => m.metric === "precision")).toBeUndefined();
    expect(result.verdict.verdict).toBe("INCONCLUSIVE");
  });
});
