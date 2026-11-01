/**
 * Verdict model for system evaluation.
 *
 * SUPPORTED | FALSIFIED | INCONCLUSIVE | INVALID | UNTESTED.
 * Every verdict states claim boundaries: what was tested, what was NOT
 * tested, dataset, sample size, conditions, metrics, uncertainty.
 */

import { checkHypothesis } from "./claim.js";
import { checkThreshold } from "./stats.js";
import type { Claim, MetricValue, VerdictRecord } from "./types.js";

export function decideVerdict(input: {
  claim?: Claim;
  metrics: readonly MetricValue[];
  thresholds?: Record<string, string>;
  datasetLabel: string;
  datasetDigest: string;
  sampleSize: number;
  repetitions: number;
  conditions: Record<string, unknown>;
  insufficientEvidence?: VerdictRecord["verdict"];
}): VerdictRecord {
  const fallback = input.insufficientEvidence ?? "INCONCLUSIVE";
  const byName = new Map(input.metrics.map((m) => [m.metric, m]));

  // No data at all → INCONCLUSIVE (or policy), never SUPPORTED.
  if (input.metrics.length === 0 || input.sampleSize === 0) {
    return verdict(fallback, input, "No observations were collected.", [], null);
  }

  const hypothesisResults: { readonly metric: string; readonly operator: string; readonly threshold: number; readonly observed: number | null; readonly satisfied: boolean | null }[] = [];
  let sawNull = false;

  if (input.claim?.hypothesis) {
    const all = [input.claim.hypothesis.primary, ...(input.claim.hypothesis.secondary ?? [])];
    for (const h of all) {
      const observed = byName.get(h.metric)?.value ?? null;
      const satisfied = observed === null || observed === undefined ? null : checkHypothesis(h, observed);
      if (satisfied === null) sawNull = true;
      hypothesisResults.push({
        metric: h.metric, operator: h.operator, threshold: h.threshold,
        observed: observed ?? null, satisfied,
      });
    }
  }

  if (input.thresholds) {
    for (const [metric, expr] of Object.entries(input.thresholds)) {
      const observed = byName.get(metric)?.value ?? null;
      const satisfied = observed === null || observed === undefined ? null : checkThreshold(observed, expr);
      if (satisfied === null) sawNull = true;
      const parsed = expr.match(/^(>=|<=|==|!=|>|<)\s*(-?\d+(\.\d+)?)$/);
      hypothesisResults.push({
        metric, operator: (parsed?.[1] ?? "?") as ">=",
        threshold: parsed ? Number(parsed[2]) : NaN,
        observed: observed ?? null, satisfied,
      });
    }
  }

  // Minimum-sample gate from the claim methodology.
  const minSamples = input.claim?.methodology?.minimum_samples;
  if (typeof minSamples === "number" && input.sampleSize < minSamples) {
    return verdict(
      fallback, input,
      `Only ${input.sampleSize} samples collected; methodology requires >= ${minSamples}.`,
      hypothesisResults, null,
    );
  }

  if (hypothesisResults.length === 0) {
    // No hypotheses and no thresholds: descriptive result, INCONCLUSIVE by policy.
    return verdict(fallback, input, "No hypothesis or thresholds defined; results are descriptive.", [], null);
  }

  if (sawNull) {
    return verdict(fallback, input, "At least one hypothesis could not be evaluated (missing metric).", hypothesisResults, null);
  }

  const allSatisfied = hypothesisResults.every((r) => r.satisfied === true);
  if (allSatisfied) {
    const primary = hypothesisResults[0];
    return verdict(
      "SUPPORTED", input,
      `All ${hypothesisResults.length} hypothesi(es) held (${primary?.metric} ${primary?.operator} ${primary?.threshold}).`,
      hypothesisResults, null,
    );
  }
  return verdict(
    "FALSIFIED", input,
    `At least one hypothesis failed: ${hypothesisResults.filter((r) => r.satisfied === false).map((r) => `${r.metric} ${r.operator} ${r.threshold} (observed ${formatNum(r.observed)})`).join("; ")}.`,
    hypothesisResults, null,
  );
}

function verdict(
  v: VerdictRecord["verdict"],
  input: Parameters<typeof decideVerdict>[0],
  summary: string,
  hypothesisResults: NonNullable<VerdictRecord["hypothesis_results"]>,
  _extra: null,
): VerdictRecord {
  void _extra;
  const metricNames = input.metrics.map((m) => m.metric);
  return {
    verdict: v,
    claim_id: input.claim?.id ?? null,
    summary,
    scope: {
      tested: input.claim?.statement ?? `metrics ${metricNames.join(", ") || "(none)"} on ${input.datasetLabel}`,
      not_tested: "Performance outside the evaluated population, dataset version, and conditions is not established by this result.",
      dataset: input.datasetLabel,
      dataset_digest: input.datasetDigest,
      sample_size: input.sampleSize,
      repetitions: input.repetitions,
      conditions: input.conditions,
      metrics: metricNames,
      uncertainty: "See per-metric confidence intervals in statistics.json; small-n intervals are wide by construction.",
    },
    ...(hypothesisResults.length > 0 ? { hypothesis_results: hypothesisResults } : {}),
  };
}

function formatNum(v: number | null): string {
  return v === null ? "n/a" : String(Math.round(v * 10000) / 10000);
}
