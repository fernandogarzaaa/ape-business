/**
 * Evaluator assurance: can we trust the mechanism deciding whether the system works?
 *
 * Two interoperable modes, both reusing the evaluation's own evaluator:
 *
 * 1. Dataset-derived probes (default). Synthesizes controls (gold outputs that
 *    must be accepted) and must-reject exploits (empty, input echo, another
 *    task's gold, gold padded with junk) from the evaluation dataset, plus
 *    informational stress probes (case/whitespace brittleness). Verdicts use
 *    the same vocabulary as the RLVR assurance module — SOUND | EXPLOITABLE |
 *    UNRELIABLE | OVER_STRICT — without touching its published taxonomy.
 *
 * 2. Suite bridge (`--suite code|json|math|behavioral`). Runs the spec's
 *    evaluator as an in-process Judge against the existing adversarial probe
 *    suites, yielding real taxonomy findings (e.g. an exact-match evaluator
 *    accepts the unmarked "42" it should reject per the task's marker rule).
 *
 * Abstinence policy: an evaluator that returns null (abstains) on a
 * must-reject probe is safe — it did not accept garbage — and is recorded as
 * a caveat, not a defect. Abstaining on a control is a false reject: an
 * evaluator that cannot judge gold cannot carry a verdict.
 */

import { wilson } from "../backtest/metrics.js";
import { runAudit, type AuditRecord } from "../assurance/audit.js";
import { getSuite } from "../assurance/suites/index.js";
import type { Judge, Observed } from "../assurance/verifier.js";
import type { Probe } from "../assurance/probe.js";
import { createEvaluator } from "./evaluators.js";
import { loadDataset } from "./dataset.js";
import type { EvalSpec } from "./spec.js";
import type { EvalTask, EvaluationVerdict } from "./types.js";

export type AssuranceVerdict = "SOUND" | "EXPLOITABLE" | "UNRELIABLE" | "OVER_STRICT";

export type AssuranceProbeKind = "control" | "must_reject" | "stress";

export interface AssuranceProbe {
  readonly id: string;
  readonly kind: AssuranceProbeKind;
  /** Exploit template: empty | echo-input | wrong-gold | padded-gold | case-flip | whitespace. */
  readonly template: string;
  readonly task_id: string;
  readonly output: unknown;
  readonly rationale: string;
}

export type AssuranceOutcome = "correct" | "false_accept" | "false_reject" | "abstained" | "stress_note";

export interface AssuranceProbeResult {
  readonly probe_id: string;
  readonly kind: AssuranceProbeKind;
  readonly template: string;
  readonly observed: "accept" | "reject" | "abstain";
  readonly outcome: AssuranceOutcome;
  readonly detail?: Record<string, unknown>;
}

export interface AssuranceFinding {
  readonly severity: "exploitable" | "over_strict" | "brittle" | "info";
  readonly summary: string;
  readonly template?: string;
  readonly probes: readonly string[];
}

export interface EvaluatorAssurance {
  readonly evaluator: string;
  readonly dataset: string;
  readonly dataset_digest: string;
  readonly probes_run: number;
  readonly controls: number;
  readonly must_rejects: number;
  readonly false_accept_rate: { point: number; low: number; high: number; n: number };
  readonly false_reject_rate: { point: number; low: number; high: number; n: number };
  readonly abstains: number;
  readonly verdict: AssuranceVerdict;
  readonly rationale: readonly string[];
  readonly findings: readonly AssuranceFinding[];
  readonly results: readonly AssuranceProbeResult[];
  readonly suite_audit?: AuditRecord;
}

const MAX_TASKS = 20;
const JUNK = Array.from({ length: 20 }, (_, i) => `junk-${i + 1}`);

export async function assureEvaluator(
  spec: EvalSpec,
  options: { stdinData?: string; suite?: string; maxTasks?: number } = {},
): Promise<EvaluatorAssurance> {
  const dataset = loadDataset({
    path: spec.dataset.path,
    inline: spec.dataset.inline,
    stdin: options.stdinData,
    format: spec.dataset.format,
    id: spec.dataset.id ?? spec.dataset.path ?? "dataset",
    version: spec.dataset.version ?? "1",
  });
  const evaluator = createEvaluator(spec.evaluator);
  const isRetrieval = spec.evaluator.type === "retrieval";

  // Gold outputs: the controls. Tasks without gold cannot anchor assurance.
  // Trajectory tasks declare scope, not answers: synthesize a minimal
  // in-scope control from the task's own allowed tools.
  const isTrajectory = spec.evaluator.type === "trajectory";
  const golds: { task: EvalTask; gold: unknown; wrongGoldOk: boolean }[] = [];
  for (const task of dataset.tasks) {
    const gold = goldOutput(task, isRetrieval);
    if (gold !== null) {
      golds.push({ task, gold, wrongGoldOk: true });
      continue;
    }
    if (isTrajectory) {
      const allowed = task.constraints?.allowed_tools;
      if (Array.isArray(allowed) && allowed.length > 0) {
        // Cross-task golds are NOT adversarial here: admissible behavior is
        // shared across scope tasks, so another task's in-scope trajectory
        // is legitimately acceptable.
        golds.push({ task, gold: { steps: [{ tool: allowed[0], target: "probe", action: "probe" }] }, wrongGoldOk: false });
      }
    }
  }

  if (golds.length === 0) {
    return empty("no task in the dataset carries a gold output (reference/expected/labels.actual/relevant_ids)", dataset, evaluator.name);
  }

  const capped = golds.slice(0, options.maxTasks ?? MAX_TASKS);
  const probes: AssuranceProbe[] = [];
  for (const { task, gold, wrongGoldOk } of capped) {
    probes.push({
      id: `${task.id}/control-gold`, kind: "control", template: "gold",
      task_id: task.id, output: gold, rationale: "Gold output. An evaluator that rejects this is unusably strict.",
    });
    probes.push(...exploits(task, gold, capped.map((g) => g.gold), isRetrieval, wrongGoldOk));
    probes.push(...stress(task, gold));
  }

  const results: AssuranceProbeResult[] = [];
  for (const probe of probes) {
    const task = dataset.tasks.find((t) => t.id === probe.task_id) as EvalTask;
    let observed: AssuranceProbeResult["observed"];
    let detail: Record<string, unknown> | undefined;
    try {
      const obs = await evaluator.evaluate(task, probe.output);
      observed = obs.passed === true ? "accept" : obs.passed === false ? "reject" : "abstain";
      if (obs.details) detail = obs.details as Record<string, unknown>;
    } catch (error) {
      observed = "abstain";
      detail = { error: (error as Error).message };
    }
    results.push({ probe_id: probe.id, kind: probe.kind, template: probe.template, observed, outcome: judgeOutcome(probe.kind, observed) });
    void detail;
  }

  const mustRejects = results.filter((r) => r.kind === "must_reject");
  const controls = results.filter((r) => r.kind === "control");
  const falseAccepts = mustRejects.filter((r) => r.outcome === "false_accept").length;
  const falseRejects = controls.filter((r) => r.outcome === "false_reject").length;
  const abstains = results.filter((r) => r.outcome === "abstained").length;

  const far = wilson(falseAccepts, mustRejects.length);
  const frr = wilson(falseRejects, controls.length);
  const { verdict, rationale } = decideAssurance(falseAccepts, falseRejects, controls.length);
  const findings = buildAssuranceFindings(results);

  let suiteAudit: AuditRecord | undefined;
  if (options.suite) {
    suiteAudit = await auditSpecEvaluatorAgainstSuite(spec, options.suite);
  }

  return {
    evaluator: evaluator.name,
    dataset: `${dataset.info.id}@${dataset.info.version}`,
    dataset_digest: dataset.info.digest,
    probes_run: results.length,
    controls: controls.length,
    must_rejects: mustRejects.length,
    false_accept_rate: far,
    false_reject_rate: frr,
    abstains,
    verdict,
    rationale,
    findings,
    results,
    ...(suiteAudit ? { suite_audit: suiteAudit } : {}),
  };
}

function empty(reason: string, dataset: { info: { id: string; version: string; digest: string } }, evaluator: string): EvaluatorAssurance {
  const zero = { point: 0, low: 0, high: 0, n: 0 };
  return {
    evaluator,
    dataset: `${dataset.info.id}@${dataset.info.version}`,
    dataset_digest: dataset.info.digest,
    probes_run: 0, controls: 0, must_rejects: 0,
    false_accept_rate: zero, false_reject_rate: zero, abstains: 0,
    verdict: "UNRELIABLE",
    rationale: [`No assurance probes could be built: ${reason}. Verdict withheld.`],
    findings: [{ severity: "info", summary: reason, probes: [] }],
    results: [],
  };
}

/** Gold output for a task, or null when the task carries no ground truth. */
function goldOutput(task: EvalTask, isRetrieval: boolean): unknown {
  if (isRetrieval) {
    const rel = task.labels?.relevant_ids ?? task.metadata?.relevant_ids;
    if (Array.isArray(rel) && rel.length > 0) return { retrieved_ids: rel };
    return null;
  }
  const gold = task.reference ?? task.expected ?? task.labels?.actual ?? null;
  return gold === null || gold === undefined ? null : gold;
}

function normStr(v: unknown): string {
  return (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).trim();
}

function exploits(task: EvalTask, gold: unknown, allGolds: readonly unknown[], isRetrieval: boolean, wrongGoldOk = true): AssuranceProbe[] {
  const out: AssuranceProbe[] = [];
  const base = `${task.id}/exploit`;

  out.push({
    id: `${base}-empty`, kind: "must_reject", template: "empty",
    task_id: task.id, output: isRetrieval ? [] : "",
    rationale: "Empty output. Accepting nothing as success is the crudest evaluator hole.",
  });

  const input = task.input;
  if (normStr(input) !== normStr(gold)) {
    out.push({
      id: `${base}-echo`, kind: "must_reject", template: "echo-input",
      task_id: task.id, output: input,
      rationale: "Input echoed back verbatim. Rewards copying instead of solving.",
    });
  }

  // Another task's gold with minimal overlap — never the same gold twice.
  // Skipped when cross-task golds are legitimately acceptable (e.g. shared
  // scope across trajectory tasks): a probe that must pass is not an exploit.
  const other = wrongGoldOk ? allGolds.filter((g) => normStr(g) !== normStr(gold)) : [];
  if (other.length > 0) {
    const ranked = [...other].sort((a, b) => overlap(a, gold) - overlap(b, gold));
    out.push({
      id: `${base}-wrong-gold`, kind: "must_reject", template: "wrong-gold",
      task_id: task.id, output: ranked[0],
      rationale: "A correct answer to a different task. Catches evaluators that accept anything well-formed.",
    });
  }

  out.push({
    id: `${base}-padded`, kind: "must_reject", template: "padded-gold",
    task_id: task.id,
    output: isRetrieval && gold && typeof gold === "object"
      ? { retrieved_ids: [...((gold as Record<string, unknown>).retrieved_ids as unknown[]), ...JUNK] }
      : `${normStr(gold)}\n${JUNK.join(" ")}`,
    rationale: "Gold padded with junk. Catches substring/scavenging judges that find a pass inside garbage.",
  });

  return out;
}

function overlap(a: unknown, b: unknown): number {
  const la = idArray(a);
  const lb = idArray(b);
  if (la && lb) {
    const set = new Set(la);
    return lb.filter((x) => set.has(x)).length;
  }
  return normStr(a) === normStr(b) ? 1 : 0;
}

function idArray(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map(String);
  if (v && typeof v === "object") {
    const r = (v as Record<string, unknown>).retrieved_ids;
    if (Array.isArray(r)) return r.map(String);
  }
  return null;
}

function stress(task: EvalTask, gold: unknown): AssuranceProbe[] {
  if (typeof gold !== "string") return [];
  const out: AssuranceProbe[] = [];
  if (gold.toLowerCase() !== gold || gold.toUpperCase() !== gold) {
    out.push({
      id: `${task.id}/stress-case`, kind: "stress", template: "case-flip",
      task_id: task.id, output: flipCase(gold),
      rationale: "Gold with flipped case. Rejection here is brittleness, not exploitability.",
    });
  }
  out.push({
    id: `${task.id}/stress-ws`, kind: "stress", template: "whitespace",
    task_id: task.id, output: `  ${gold}  \n`,
    rationale: "Gold with surrounding whitespace. Rejection here is brittleness, not exploitability.",
  });
  return out;
}

function flipCase(s: string): string {
  return [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("");
}

function judgeOutcome(kind: AssuranceProbeKind, observed: "accept" | "reject" | "abstain"): AssuranceOutcome {
  if (kind === "stress") return observed === "accept" ? "correct" : "stress_note";
  if (kind === "control") return observed === "accept" ? "correct" : "false_reject";
  // must_reject: abstaining is safe (garbage was not accepted) — a caveat, not a defect.
  if (observed === "accept") return "false_accept";
  if (observed === "reject") return "correct";
  return "abstained";
}

function decideAssurance(
  falseAccepts: number, falseRejects: number, controls: number,
): { verdict: AssuranceVerdict; rationale: string[] } {
  if (controls === 0) {
    return { verdict: "UNRELIABLE", rationale: ["No controls ran; verdict withheld."] };
  }
  if (falseAccepts > 0) {
    return {
      verdict: "EXPLOITABLE",
      rationale: [`The evaluator accepted ${falseAccepts} must-reject probe(s) — garbage it should have refused.`],
    };
  }
  if (falseRejects > 0) {
    return {
      verdict: "OVER_STRICT",
      rationale: [`No exploit succeeded, but the evaluator rejected ${falseRejects} gold control(s). Sound against these probes and unusable in practice.`],
    };
  }
  return {
    verdict: "SOUND",
    rationale: [`No must-reject probe was accepted and all ${controls} gold control(s) passed. Sound against these probes — which bounds the claim to the templates covered.`],
  };
}

function buildAssuranceFindings(results: readonly AssuranceProbeResult[]): AssuranceFinding[] {
  const findings: AssuranceFinding[] = [];
  const falses = results.filter((r) => r.outcome === "false_accept");
  const byTemplate = new Map<string, AssuranceProbeResult[]>();
  for (const r of falses) {
    const l = byTemplate.get(r.template) ?? [];
    l.push(r);
    byTemplate.set(r.template, l);
  }
  for (const [template, rs] of [...byTemplate.entries()].sort()) {
    findings.push({
      severity: "exploitable",
      summary: `The evaluator accepted ${rs.length} "${template}" probe(s) — outputs it should have rejected.`,
      template,
      probes: rs.map((r) => r.probe_id),
    });
  }
  const rejects = results.filter((r) => r.outcome === "false_reject");
  if (rejects.length > 0) {
    findings.push({
      severity: "over_strict",
      summary: `The evaluator rejected ${rejects.length} gold control(s). Over-strictness gets the gate switched off.`,
      probes: rejects.map((r) => r.probe_id),
    });
  }
  const brittle = results.filter((r) => r.outcome === "stress_note");
  if (brittle.length > 0) {
    findings.push({
      severity: "brittle",
      summary: `${brittle.length} stress probe(s) rejected (case/whitespace variants of gold). Brittleness, not exploitability — normalize before comparing.`,
      probes: brittle.map((r) => r.probe_id),
    });
  }
  const abstained = results.filter((r) => r.outcome === "abstained");
  if (abstained.length > 0) {
    findings.push({
      severity: "info",
      summary: `${abstained.length} must-reject probe(s) abstained (no judgment). Safe — garbage was not accepted — but verdicts cannot rely on abstained trials.`,
      probes: abstained.map((r) => r.probe_id),
    });
  }
  return findings;
}

// ── suite bridge ──────────────────────────────────────────────────────────

/**
 * Run the spec's evaluator as an in-process Judge against a published
 * adversarial probe suite. Probe tasks adapt to EvalTasks (prompt → input,
 * reference → reference, full task visible under context); the probe
 * completion is the output under judgment.
 */
export async function auditSpecEvaluatorAgainstSuite(spec: EvalSpec, suiteName: string): Promise<AuditRecord> {
  const suite = getSuite(suiteName);
  if (!suite) throw new Error(`unknown suite "${suiteName}"`);
  const evaluator = createEvaluator(spec.evaluator);
  const judge: Judge = {
    name: `evaluator:${spec.name}`,
    describe: () => ({ genesis_evaluator: evaluator.describe() }),
    judge: async (probe: Probe) => {
      const task: EvalTask = {
        id: probe.id,
        input: probe.task.prompt,
        ...(probe.task.reference !== undefined ? { reference: probe.task.reference } : {}),
        context: probe.task as unknown as Record<string, unknown>,
        kind: "reference-based",
      };
      const started = Date.now();
      try {
        const obs = await evaluator.evaluate(task, probe.completion);
        const observed: Observed = obs.passed === true ? "accept" : obs.passed === false ? "reject" : "error";
        return {
          observed, exit_code: null, raw_reward: typeof obs.score === "number" ? obs.score : null,
          stdout: JSON.stringify(obs.details ?? {}).slice(0, 4000), stderr: "",
          duration_ms: Date.now() - started,
          note: obs.passed === null ? "evaluator abstained (null judgment)" : null,
        };
      } catch (error) {
        return {
          observed: "error", exit_code: null, raw_reward: null, stdout: "", stderr: "",
          duration_ms: Date.now() - started, note: (error as Error).message,
        };
      }
    },
  };
  return runAudit({ verifier: judge, suite });
}

// ── combined trust ────────────────────────────────────────────────────────

export type TrustVerdict = "TRUSTED" | "UNTRUSTED" | "INCONCLUSIVE";

export interface TrustJudgment {
  readonly trust: TrustVerdict;
  readonly system_verdict: EvaluationVerdict;
  readonly evaluator_verdict: AssuranceVerdict;
  readonly reasons: readonly string[];
}

export function decideTrust(system: EvaluationVerdict, evaluator: AssuranceVerdict): TrustJudgment {
  const reasons: string[] = [];
  if (system === "INVALID") {
    reasons.push("The evaluation specification is invalid; no conclusion of any kind is available until it is fixed.");
    return { trust: "INCONCLUSIVE", system_verdict: system, evaluator_verdict: evaluator, reasons };
  }
  if (evaluator === "UNRELIABLE") {
    reasons.push("The evaluator could not be assured (no usable probes or unreadable judgments); the system verdict cannot be trusted yet.");
    return { trust: "INCONCLUSIVE", system_verdict: system, evaluator_verdict: evaluator, reasons };
  }
  if (evaluator === "EXPLOITABLE") {
    reasons.push("The evaluator accepts garbage it should reject. A SUPPORTED verdict from this evaluator means nothing — do not promote the system.");
    return { trust: "UNTRUSTED", system_verdict: system, evaluator_verdict: evaluator, reasons };
  }
  if (evaluator === "OVER_STRICT") {
    reasons.push("The evaluator rejects gold outputs. Fix the evaluator (or the golds) and re-run before trusting any verdict.");
    return { trust: "INCONCLUSIVE", system_verdict: system, evaluator_verdict: evaluator, reasons };
  }
  // Evaluator SOUND from here on: trust is about evidence quality, not outcome.
  if (system === "SUPPORTED") {
    reasons.push("System claim held under a sound evaluator. Trust is bounded to the evaluated population and probes.");
    return { trust: "TRUSTED", system_verdict: system, evaluator_verdict: evaluator, reasons };
  }
  if (system === "FALSIFIED") {
    reasons.push("System claim failed under a sound evaluator. The negative result itself is trustworthy evidence.");
    return { trust: "TRUSTED", system_verdict: system, evaluator_verdict: evaluator, reasons };
  }
  reasons.push("The system evaluation was inconclusive despite a sound evaluator; collect more evidence.");
  return { trust: "INCONCLUSIVE", system_verdict: system, evaluator_verdict: evaluator, reasons };
}

export function renderAssurance(a: EvaluatorAssurance): string {
  const L: string[] = [];
  const pct = (v: { point: number; low: number; high: number; n: number }) =>
    v.n === 0 ? "n/a (no cases)" : `${(v.point * 100).toFixed(1)}% [${(v.low * 100).toFixed(1)}–${(v.high * 100).toFixed(1)}%, n=${v.n}]`;
  L.push("");
  L.push(`EVALUATOR VERDICT: ${a.verdict}`);
  L.push(`Evaluator "${a.evaluator}" against ${a.probes_run} dataset-derived probes (${a.must_rejects} must-reject, ${a.controls} control)`);
  L.push(`Dataset ${a.dataset} (${a.dataset_digest.slice(0, 20)}…)`);
  L.push("");
  L.push(`  False-accept   ${pct(a.false_accept_rate)}`);
  L.push(`  False-reject   ${pct(a.false_reject_rate)}`);
  if (a.abstains > 0) L.push(`  Abstained      ${a.abstains} probe(s) — safe, but verdicts cannot rely on them`);
  L.push("");
  if (a.findings.length > 0) {
    L.push(`FINDINGS (${a.findings.length})`);
    for (const f of a.findings) {
      L.push(`  [${f.severity}] ${f.summary}`);
      if (f.probes.length > 0) L.push(`    probes: ${f.probes.slice(0, 8).join(", ")}${f.probes.length > 8 ? "…" : ""}`);
    }
    L.push("");
  }
  L.push("WHY");
  for (const r of a.rationale) L.push(`  ${r}`);
  L.push("");
  L.push("SCOPE: dataset-derived probes cover garbage/echo/wrong-answer/padding resistance only. For taxonomy-grade");
  L.push("assurance (reward hacking, marker checks, tolerance), re-run with --suite code|json|math.");
  if (a.suite_audit) {
    L.push("");
    L.push(`SUITE BRIDGE: ${a.suite_audit.conclusion.verdict} against ${a.suite_audit.suite}@${a.suite_audit.suite_version}`);
    for (const f of a.suite_audit.conclusion.findings.slice(0, 5)) {
      L.push(`  [${f.severity}] ${f.defect_class} — ${f.title}`);
    }
  }
  L.push("");
  return L.join("\n");
}

export function renderTrust(
  systemLabel: string,
  systemSummary: string,
  assurance: EvaluatorAssurance,
  trust: TrustJudgment,
): string {
  const L: string[] = [];
  L.push("");
  L.push(`TRUST: ${trust.trust}`);
  L.push(`${systemLabel}: ${trust.system_verdict} · evaluator: ${trust.evaluator_verdict}`);
  L.push(systemSummary);
  L.push("");
  for (const r of trust.reasons) L.push(`  ${r}`);
  L.push("");
  L.push(renderAssurance(assurance));
  return L.join("\n");
}
