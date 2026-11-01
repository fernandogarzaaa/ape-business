/**
 * Release gate: the capability checkpoint.
 *
 * A gate binds a dangerous capability to its required certifications:
 * the system verdict, the forbidden-metric ceilings, the evaluator's
 * soundness, and the combined trust — all computed from the same evidence.
 * Fail-closed: RELEASE requires everything to hold; missing evidence,
 * an untrusted evaluator, or a breached ceiling BLOCKS (or INCONCLUSIVE
 * when the evidence itself is insufficient rather than damning).
 *
 * Ceilings come from `spec.gate.forbidden` ({metric: max allowed value}).
 * A forbidden metric that cannot be computed is a breach: an unmeasured
 * dangerous capability is not an absent one.
 */

import type { EvaluatorAssurance } from "./assurance.js";
import type { ExperimentResult } from "./runner.js";
import type { MetricValue } from "./types.js";

export type GateDecision = "RELEASE" | "BLOCK" | "INCONCLUSIVE";

export interface GateBreach {
  readonly kind: "forbidden" | "system" | "evaluator" | "trust" | "evidence";
  readonly detail: string;
}

export interface GateResult {
  readonly decision: GateDecision;
  readonly system_verdict: ExperimentResult["verdict"]["verdict"];
  readonly evaluator_verdict: EvaluatorAssurance["verdict"];
  readonly trust: "TRUSTED" | "UNTRUSTED" | "INCONCLUSIVE";
  readonly breaches: readonly GateBreach[];
  readonly reasons: readonly string[];
}

export function decideGate(
  result: ExperimentResult,
  assurance: EvaluatorAssurance,
  trust: GateResult["trust"],
  forbidden: Record<string, number> = {},
): GateResult {
  const breaches: GateBreach[] = [];
  const reasons: string[] = [];
  const byName = new Map<string, MetricValue>(result.arms[0]?.metrics.map((m) => [m.metric, m]) ?? []);

  for (const [metric, ceiling] of Object.entries(forbidden)) {
    const observed = byName.get(metric)?.value ?? null;
    if (observed === null || observed === undefined) {
      breaches.push({ kind: "forbidden", detail: `${metric}: unmeasured (ceiling ${ceiling}) — an unmeasured capability is not an absent one` });
    } else if (observed >= ceiling) {
      breaches.push({ kind: "forbidden", detail: `${metric}: observed ${round(observed)} meets/exceeds ceiling ${ceiling}` });
    }
  }

  const system = result.verdict.verdict;
  if (system === "INVALID") breaches.push({ kind: "system", detail: "evaluation specification is invalid" });
  if (system === "FALSIFIED") breaches.push({ kind: "system", detail: `claim failed: ${result.verdict.summary}` });

  if (assurance.verdict === "EXPLOITABLE") {
    breaches.push({ kind: "evaluator", detail: "evaluator accepts garbage — absence of evidence is not evidence of absence" });
  }
  if (trust === "UNTRUSTED") {
    breaches.push({ kind: "trust", detail: "combined trust is UNTRUSTED" });
  }

  const insufficient =
    system === "INCONCLUSIVE" ||
    system === "UNTESTED" ||
    assurance.verdict === "UNRELIABLE" ||
    assurance.verdict === "OVER_STRICT" ||
    (trust === "INCONCLUSIVE" && breaches.length === 0);

  let decision: GateDecision;
  if (breaches.length > 0) {
    decision = "BLOCK";
    reasons.push(`${breaches.length} blocking condition(s): ${breaches.map((b) => b.detail).join("; ")}.`);
  } else if (insufficient) {
    decision = "INCONCLUSIVE";
    reasons.push("No blocking condition, but evidence is insufficient for release: collect more evidence and re-gate.");
  } else {
    decision = "RELEASE";
    reasons.push(
      `Claim ${system === "SUPPORTED" ? "held" : system} under a ${assurance.verdict} evaluator with trust ${trust}; ` +
      `no forbidden ceiling breached. Release is bounded to the evaluated population.`,
    );
  }

  return {
    decision,
    system_verdict: system,
    evaluator_verdict: assurance.verdict,
    trust,
    breaches,
    reasons,
  };
}

export function renderGate(
  label: string,
  forbidden: Record<string, number>,
  gate: GateResult,
): string {
  const L: string[] = [];
  L.push("");
  L.push(`GATE: ${gate.decision}`);
  L.push(`${label}: system ${gate.system_verdict} · evaluator ${gate.evaluator_verdict} · trust ${gate.trust}`);
  L.push("");
  L.push("CHECKPOINTS");
  const names = Object.keys(forbidden);
  if (names.length === 0) L.push("  (no forbidden ceilings declared — add spec.gate.forbidden)");
  for (const name of names) {
    const breach = gate.breaches.find((b) => b.kind === "forbidden" && b.detail.startsWith(`${name}:`));
    L.push(`  ${breach ? "✗ BLOCKED" : "✓ clear"}   ${name} must stay below ${forbidden[name]}${breach ? ` — ${breach.detail}` : ""}`);
  }
  for (const b of gate.breaches.filter((x) => x.kind !== "forbidden")) {
    L.push(`  ✗ BLOCKED   [${b.kind}] ${b.detail}`);
  }
  L.push("");
  for (const r of gate.reasons) L.push(`  ${r}`);
  L.push("");
  return L.join("\n");
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}
