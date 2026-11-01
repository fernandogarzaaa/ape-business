/**
 * Reporting: what was evaluated, why, against what baseline, using what
 * data, what happened, how confident we are, where it failed, what
 * improved/regressed, whether the evaluator can be trusted, what to
 * investigate next. No vanity dashboards.
 */

import { formatInterval, type Interval } from "../backtest/metrics.js";
import type { ExperimentResult } from "./runner.js";

export function renderReport(result: ExperimentResult): string {
  const L: string[] = [];
  const v = result.verdict;
  L.push("");
  L.push(`VERDICT: ${v.verdict}`);
  L.push(`${result.name}`);
  L.push(v.summary);
  L.push("");
  L.push("SCOPE");
  L.push(`  Tested:     ${v.scope.tested.slice(0, 300)}`);
  L.push(`  Not tested: ${v.scope.not_tested}`);
  L.push(`  Dataset:    ${v.scope.dataset} (${v.scope.dataset_digest.slice(0, 20)}…)`);
  L.push(`  Samples:    N=${v.scope.sample_size}, repetitions=${v.scope.repetitions}`);
  L.push(`  Metrics:    ${v.scope.metrics.join(", ") || "(none)"}`);
  L.push(`  Uncertainty:${v.scope.uncertainty}`);
  L.push("");

  for (const arm of result.arms) {
    L.push(`ARM: ${arm.arm} — ${arm.trials.length} trials`);
    for (const m of arm.metrics) {
      const stat = arm.statistics.find((s) => s?.metric === m.metric);
      if (stat && isRate(m.metric)) {
        const iv: Interval = { point: stat.mean, low: stat.ci95.low, high: stat.ci95.high, n: stat.n };
        L.push(`  ${m.metric.padEnd(22)} ${formatInterval(iv)}${m.unit ? ` ${m.unit}` : ""}`);
      } else if (stat) {
        L.push(
          `  ${m.metric.padEnd(22)} ${fmt(stat.mean)} [${fmt(stat.ci95.low)}–${fmt(stat.ci95.high)}, n=${stat.n}]${m.unit ? ` ${m.unit}` : ""}`,
        );
      } else {
        L.push(`  ${m.metric.padEnd(22)} ${fmt(m.value)} [n=${m.n}, no interval]`);
      }
    }
    if (arm.metrics.length === 0) L.push("  (no metrics computed)");
    L.push("");
  }

  if (result.comparisons.length > 0) {
    L.push("COMPARISONS (paired, descriptive — not significance tests)");
    for (const c of result.comparisons) {
      const d = c.effect_size_cohens_d === null ? "d=n/a" : `d=${c.effect_size_cohens_d.toFixed(2)}`;
      L.push(
        `  ${c.metric}: baseline ${fmt(c.baseline_mean)} → treatment ${fmt(c.treatment_mean)} ` +
        `(Δ ${fmt(c.delta)}${c.relative_delta === null ? "" : `, ${(c.relative_delta * 100).toFixed(1)}%`}, ${d}, n=${c.n_pairs})`,
      );
      L.push(`    95% CI of Δ: [${fmt(c.ci95_delta.low)}, ${fmt(c.ci95_delta.high)}] via ${c.method}`);
    }
    L.push("");
  }

  if (result.findings.length > 0) {
    L.push(`FINDINGS (${result.findings.length})`);
    for (const f of result.findings) {
      L.push(`  [${f.severity}] ${f.category} — ${f.summary}`);
      if (f.possible_cause) L.push(`    possible cause: ${f.possible_cause}`);
    }
    L.push("");
  }

  if (v.hypothesis_results && v.hypothesis_results.length > 0) {
    L.push("HYPOTHESES");
    for (const h of v.hypothesis_results) {
      const mark = h.satisfied === true ? "✓" : h.satisfied === false ? "✗" : "?";
      L.push(`  ${mark} ${h.metric} ${h.operator} ${h.threshold} (observed ${h.observed === null ? "n/a" : fmt(h.observed)})`);
    }
    L.push("");
  }

  L.push("EVALUATOR TRUST");
  const gaps = result.findings.filter((f) => f.category === "evaluator-gap");
  if (gaps.length === 0) {
    L.push("  The evaluator produced a judgment for every trial. That does not make it correct —");
    L.push("  run `genesis audit evaluator` / adversarial trials to assure it (`docs/assurance/README.md`).");
  } else {
    L.push(`  ${gaps.length} evaluator-gap finding(s): the evaluator failed to judge some trials.`);
    L.push("  Do not trust the verdict until the evaluator is assured.");
  }
  L.push("");
  L.push("NEXT STEPS");
  L.push(...nextSteps(result).map((s) => `  - ${s}`));
  L.push("");
  return L.join("\n");
}

function nextSteps(result: ExperimentResult): string[] {
  const steps: string[] = [];
  const failed = result.findings.find((f) => f.category === "task-failure");
  if (failed) steps.push(`Inspect failing tasks first: ${failed.affected_tasks.slice(0, 3).join(", ") || "see findings.json"}.`);
  if (result.findings.some((f) => f.category === "evaluator-gap")) {
    steps.push("Fix evaluator coverage (missing judgments / unreadable outputs), then re-run.");
  }
  if (result.verdict.verdict === "INCONCLUSIVE") steps.push("Collect more samples or fix metric coverage to reach a decisive verdict.");
  if (result.comparisons.length === 0 && result.arms.length === 1) {
    steps.push("Add a baseline to answer 'did it improve?' with a paired comparison.");
  }
  steps.push("Assure the evaluator adversarially before promoting this result (`genesis audit --suite ...`).");
  return steps;
}

function fmt(v: number): string {
  return String(Math.round(v * 10000) / 10000);
}

function isRate(metric: string): boolean {
  return /^(task_success|accuracy|exact_match|mean_score|failure_rate|timeout_rate|error_rate|success_rate|precision|recall|f1|roc_auc|pr_auc|retrieval_precision|retrieval_recall|retrieval_f1|context_relevance|faithfulness|answer_correctness)$/.test(metric) || metric.startsWith("detail:");
}
