/**
 * Comparison, regression gates, and ablation tables over evidence bundles.
 *
 * - compare: run-a vs run-b metric deltas from treatment/metrics.json.
 * - regression: gate a candidate bundle against thresholds (quality max drop,
 *   p95 latency / cost max increase). Exit-code friendly.
 * - ablation: per-arm metric table across treatment/baseline/ablations.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BundleMetrics {
  readonly verdict: { readonly verdict: string };
  readonly metrics: readonly { metric: string; value: number; n: number }[];
  readonly stats?: unknown;
}

export function loadBundleMetrics(dir: string): BundleMetrics {
  const verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")) as BundleMetrics["verdict"];
  let metrics: BundleMetrics["metrics"] = [];
  for (const cand of [join(dir, "treatment", "metrics.json"), join(dir, "baseline", "metrics.json")]) {
    try {
      metrics = JSON.parse(readFileSync(cand, "utf8")) as BundleMetrics["metrics"];
      break;
    } catch {
      // try next
    }
  }
  return { verdict, metrics };
}

export interface Delta {
  readonly metric: string;
  readonly a: number | null;
  readonly b: number | null;
  readonly delta: number | null;
  readonly relative: number | null;
}

export function compareBundles(aDir: string, bDir: string): { a: BundleMetrics; b: BundleMetrics; deltas: Delta[] } {
  const a = loadBundleMetrics(aDir);
  const b = loadBundleMetrics(bDir);
  const am = new Map(a.metrics.map((m) => [m.metric, m.value]));
  const bm = new Map(b.metrics.map((m) => [m.metric, m.value]));
  const names = [...new Set([...am.keys(), ...bm.keys()])].sort();
  const deltas: Delta[] = names.map((metric) => {
    const av = am.get(metric) ?? null;
    const bv = bm.get(metric) ?? null;
    const delta = av === null || bv === null ? null : bv - av;
    const relative = delta === null || av === 0 || av === null ? null : delta / Math.abs(av);
    return { metric, a: av, b: bv, delta, relative };
  });
  return { a, b, deltas };
}

export function renderComparison(aDir: string, bDir: string): string {
  const { a, b, deltas } = compareBundles(aDir, bDir);
  const L = ["", `COMPARE: ${aDir} (A) vs ${bDir} (B)`, `verdicts: A=${a.verdict.verdict} B=${b.verdict.verdict}`, ""];
  for (const d of deltas) {
    const rel = d.relative === null ? "" : ` (${(d.relative * 100).toFixed(1)}%)`;
    L.push(`  ${d.metric.padEnd(22)} A=${fmt(d.a)} B=${fmt(d.b)} Δ=${fmt(d.delta)}${rel}`);
  }
  L.push("");
  return L.join("\n");
}

export interface RegressionConfig {
  readonly quality?: { readonly max_drop?: number };
  readonly p95_latency?: { readonly max_increase?: number };
  readonly cost?: { readonly max_increase?: number };
}

export interface RegressionResult {
  readonly pass: boolean;
  readonly checks: readonly { readonly name: string; readonly pass: boolean; readonly detail: string }[];
}

export function checkRegression(baseDir: string, candDir: string, config: RegressionConfig): RegressionResult {
  const base = loadBundleMetrics(baseDir);
  const cand = loadBundleMetrics(candDir);
  const bm = new Map(base.metrics.map((m) => [m.metric, m.value]));
  const cm = new Map(cand.metrics.map((m) => [m.metric, m.value]));
  const checks: { name: string; pass: boolean; detail: string }[] = [];

  const qDrop = config.quality?.max_drop;
  if (qDrop !== undefined) {
    const b = bm.get("task_success") ?? bm.get("accuracy") ?? null;
    const c = cm.get("task_success") ?? cm.get("accuracy") ?? null;
    if (b === null || c === null) {
      checks.push({ name: "quality", pass: false, detail: "missing task_success/accuracy in one bundle" });
    } else {
      const drop = b - c;
      checks.push({
        name: "quality", pass: drop <= qDrop,
        detail: `baseline ${fmt(b)} → candidate ${fmt(c)} (drop ${fmt(drop)}, allowed ${qDrop})`,
      });
    }
  }
  const latInc = config.p95_latency?.max_increase;
  if (latInc !== undefined) {
    const b = bm.get("p95_latency_ms") ?? null;
    const c = cm.get("p95_latency_ms") ?? null;
    if (b === null || c === null) {
      checks.push({ name: "p95_latency", pass: false, detail: "missing p95_latency_ms in one bundle" });
    } else {
      const rel = b === 0 ? 0 : (c - b) / Math.abs(b);
      checks.push({
        name: "p95_latency", pass: rel <= latInc,
        detail: `baseline ${fmt(b)}ms → candidate ${fmt(c)}ms (increase ${(rel * 100).toFixed(1)}%, allowed ${(latInc * 100).toFixed(1)}%)`,
      });
    }
  }
  const costInc = config.cost?.max_increase;
  if (costInc !== undefined) {
    const b = bm.get("mean_cost_usd") ?? bm.get("total_cost_usd") ?? null;
    const c = cm.get("mean_cost_usd") ?? cm.get("total_cost_usd") ?? null;
    if (b === null || c === null) {
      checks.push({ name: "cost", pass: true, detail: "no cost metrics recorded — nothing to gate" });
    } else {
      const rel = b === 0 ? 0 : (c - b) / Math.abs(b);
      checks.push({
        name: "cost", pass: rel <= costInc,
        detail: `baseline ${fmt(b)} → candidate ${fmt(c)} (increase ${(rel * 100).toFixed(1)}%, allowed ${(costInc * 100).toFixed(1)}%)`,
      });
    }
  }
  return { pass: checks.every((c) => c.pass), checks };
}

function fmt(v: number | null): string {
  return v === null ? "n/a" : String(Math.round(v * 10000) / 10000);
}
