/**
 * Statistics: estimates with method, assumptions, and uncertainty.
 *
 * No automatic "significance" claims. Every result exposes n, method,
 * assumptions, and intervals. Small-n intervals are wide — saying so is the
 * deliverable (same discipline as backtest/metrics.ts Wilson reporting).
 */

import { wilson } from "../backtest/metrics.js";
import type { PairedComparison, StatisticalResult } from "./types.js";

export { wilson };

export function describe(values: readonly number[], metric: string): StatisticalResult | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return null;
  const sorted = [...v].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  const median = quantile(sorted, 0.5);
  const p50 = median;
  const p95 = quantile(sorted, 0.95);
  const p99 = quantile(sorted, 0.99);
  const boot = bootstrapMeanCI(sorted, 2000, 0.95, n);
  return {
    metric, n, mean, stddev, median, p50, p95, p99,
    ci95: { low: boot.low, high: boot.high, method: "bootstrap-percentile-2000" },
    assumptions: [
      "trials are independent and identically distributed within this arm",
      `bootstrap resampling (n=${n}); intervals are wide at small n by construction`,
      "no multiple-comparison correction applied — see per-metric intervals",
    ],
  };
}

/** Binary-rate summary with Wilson interval (reuses backtest module). */
export function describeRate(successes: number, total: number, metric: string): StatisticalResult | null {
  if (total === 0) return null;
  const iv = wilson(successes, total);
  return {
    metric, n: total, mean: iv.point, stddev: Math.sqrt((iv.point * (1 - iv.point)) / total),
    median: iv.point, p50: iv.point, p95: iv.point, p99: iv.point,
    ci95: { low: iv.low, high: iv.high, method: "wilson-95" },
    assumptions: ["Bernoulli trials; Wilson interval valid near 0/1 unlike normal approximation"],
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0] as number;
  const rank = q * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (rank - lo);
}

/** Deterministic PRNG (mulberry32) so bootstrap CIs are reproducible by seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMeanCI(
  values: readonly number[],
  resamples = 2000,
  level = 0.95,
  seed = 1,
): { low: number; high: number } {
  const v = [...values];
  if (v.length === 0) return { low: NaN, high: NaN };
  if (v.length === 1) return { low: v[0] as number, high: v[0] as number };
  const rand = mulberry32(typeof seed === "number" ? seed : 1);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[Math.floor(rand() * v.length)] as number;
    means.push(s / v.length);
  }
  means.sort((a, b) => a - b);
  const alpha = 1 - level;
  return {
    low: quantile(means, alpha / 2),
    high: quantile(means, 1 - alpha / 2),
  };
}

/**
 * Paired comparison (same task population in both arms). Reports delta,
 * relative delta, Cohen's d on paired differences, and bootstrap CI of the
 * mean paired difference. Never declares significance.
 */
export function pairedCompare(
  baseline: ReadonlyMap<string, number> | Record<string, number>,
  treatment: ReadonlyMap<string, number> | Record<string, number>,
  metric: string,
): PairedComparison | null {
  const b = baseline instanceof Map ? baseline : new Map(Object.entries(baseline));
  const t = treatment instanceof Map ? treatment : new Map(Object.entries(treatment));
  const keys = [...b.keys()].filter((k) => t.has(k));
  if (keys.length === 0) return null;
  const diffs = keys.map((k) => (t.get(k) as number) - (b.get(k) as number));
  const bMean = keys.reduce((a, k) => a + (b.get(k) as number), 0) / keys.length;
  const tMean = keys.reduce((a, k) => a + (t.get(k) as number), 0) / keys.length;
  const delta = tMean - bMean;
  const dMean = diffs.reduce((a, x) => a + x, 0) / diffs.length;
  const dSd = diffs.length > 1
    ? Math.sqrt(diffs.reduce((a, x) => a + (x - dMean) ** 2, 0) / (diffs.length - 1))
    : 0;
  const cohensD = dSd === 0 ? null : dMean / dSd;
  const ci = bootstrapMeanCI(diffs, 2000, 0.95, keys.length);
  return {
    metric,
    baseline_mean: bMean,
    treatment_mean: tMean,
    delta,
    relative_delta: bMean === 0 ? null : delta / Math.abs(bMean),
    effect_size_cohens_d: cohensD,
    ci95_delta: { low: ci.low, high: ci.high, method: "bootstrap-percentile-2000-paired-differences" },
    n_pairs: keys.length,
    method: "paired-difference-bootstrap",
    assumptions: [
      "same task population in both arms (paired by task id)",
      "pairs independent; bootstrap over paired differences",
      "effect size is descriptive, not a significance test",
    ],
  };
}

/** Parse a threshold expression like ">=0.90" → {op, value}. */
export function parseThreshold(expr: string): { op: string; value: number } | null {
  const m = expr.trim().match(/^(>=|<=|==|!=|>|<)\s*(-?\d+(\.\d+)?)$/);
  if (!m) return null;
  return { op: m[1] as string, value: Number(m[2]) };
}

export function checkThreshold(value: number | null, expr: string): boolean | null {
  if (value === null || !Number.isFinite(value)) return null;
  const t = parseThreshold(expr);
  if (!t) return null;
  switch (t.op) {
    case ">=": return value >= t.value;
    case "<=": return value <= t.value;
    case ">": return value > t.value;
    case "<": return value < t.value;
    case "==": return value === t.value;
    case "!=": return value !== t.value;
    default: return null;
  }
}
