// Harness evolution from trajectories — analyze a profile's recent runs and propose
// concrete profile edits. This is how profiles improve from ledger evidence instead of
// guesswork. Crucially, suggestions are CAUSAL, not metric→patch jumps: every
// suggestion carries ranked cause hypotheses with confidence and the evidence behind
// them (symptom → hypotheses → intervention), because "raise the ceiling" is the
// wrong fix for a looping agent, and "add a fallback" is wrong when no credential
// exists to serve it. Trajectory signals come from run receipts (drift, evidence,
// tool variety); rows without receipts (legacy/seeded) lower confidence instead of
// blocking analysis.
//
// The analyzer never mutates profiles itself. It returns findings + exact patches the
// user applies (e.g. in the console Agent tab), keeping a human in the loop. It can
// optionally record a belief so the learning persists in ADAM.
import { recentRuns } from "../runs.js";
import { loadProfile } from "./profiles.js";
import { defaultModelFor } from "./providers.js";
import { adamCall } from "../adam-client.js";

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function parseReceipt(r) {
  try { return JSON.parse(r.receipt ?? "null") ?? {}; }
  catch { return {}; }
}

// Per-window trajectory signals from receipts. Rows without receipts contribute
// only their stop_reason — confidence in any trajectory claim drops accordingly.
function trajectorySignals(runs) {
  const sig = { withReceipts: 0, stuckStops: 0, driftWarned: 0, maxStreak: 0, evidenced: 0, narrowTooling: 0 };
  for (const r of runs) {
    if (r.stop_reason === "repetition_detected" || r.stop_reason === "error_spiral") sig.stuckStops++;
    const rc = parseReceipt(r);
    if (!rc || !Object.keys(rc).length) continue;
    sig.withReceipts++;
    const d = rc.drift ?? {};
    if ((d.warnings ?? 0) > 0) sig.driftWarned++;
    if ((d.max_same_tool_streak ?? 0) > sig.maxStreak) sig.maxStreak = d.max_same_tool_streak;
    if (Array.isArray(rc.evidence) && rc.evidence.length > 0) sig.evidenced++;
    if ((d.distinct_tools ?? 99) <= 2) sig.narrowTooling++;
  }
  return sig;
}

// Sync credential presence for fallback candidates (analyzeProfile stays sync;
// async host probing is out of scope here — absence means "not visibly
// available", and the rationale says so).
const FALLBACK_CANDIDATES = [
  { provider: "openrouter", env: ["OPENROUTER_API_KEY"] },
  { provider: "openai", env: ["OPENAI_API_KEY"] },
  { provider: "anthropic", env: ["ANTHROPIC_API_KEY"] },
  { provider: "groq", env: ["GROQ_API_KEY"] },
];
function pickFallback() {
  for (const c of FALLBACK_CANDIDATES) {
    if (c.env.some((k) => process.env[k])) {
      return { provider: c.provider, id: defaultModelFor(c.provider) ?? "auto", via: c.env.find((k) => process.env[k]) };
    }
  }
  return null;
}

export function analyzeProfile(profileName, { window = 20 } = {}) {
  const profile = loadProfile(profileName);
  if (!profile) return { error: "profile_not_found", profile: profileName };
  const runs = recentRuns(profileName, window).filter((r) => r.status !== "running");
  if (!runs.length) {
    return { profile: profileName, runs: 0, findings: [], suggestions: [], note: "no finished runs in window" };
  }
  const n = runs.length;
  const byStop = {};
  for (const r of runs) byStop[r.stop_reason ?? "?"] = (byStop[r.stop_reason ?? "?"] ?? 0) + 1;
  const done = runs.filter((r) => r.status === "done").length;
  const costs = runs.map((r) => Number(r.total_cost ?? 0));
  const steps = runs.map((r) => Number(r.step_count ?? 0));
  const unverified = runs.filter((r) => r.unverified).length;
  const maxStepsHits = (byStop.max_steps ?? 0) + (byStop.max_wall_seconds ?? 0);
  const repetitions = byStop.repetition_detected ?? 0;
  const modelErrors = (byStop.model_error ?? 0) + (byStop.no_provider ?? 0);

  const findings = [];
  const suggestions = [];
  const limits = profile.limits ?? {};

  findings.push({ metric: "completion_rate", value: `${done}/${n}`, detail: "done runs over finished runs in window" });
  findings.push({ metric: "stop_reasons", value: byStop, detail: "terminal states observed" });
  findings.push({
    metric: "cost_per_task", value: { median_usd: Number(median(costs).toFixed(6)), median_steps: median(steps) },
    detail: "median cost and steps per finished run",
  });

  // Chronic budget ceiling: symptom, not diagnosis. Raising the ceiling is only
  // right when trajectories look HEALTHY (evidence gathered, varied tools, no
  // drift) — otherwise the loop is stuck and more budget means more waste.
  if (maxStepsHits >= Math.max(2, Math.ceil(n * 0.4))) {
    const sorted = [...steps].sort((a, b) => a - b);
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    const current = Number(limits.max_steps ?? 12);
    const proposed = Math.max(current + 4, p90 + 2);
    const sig = trajectorySignals(runs);
    const ceilingRuns = runs.filter((r) => r.stop_reason === "max_steps" || r.stop_reason === "max_wall_seconds");
    const ceilingStuck = ceilingRuns.filter((r) => {
      const d = parseReceipt(r).drift ?? {};
      return (d.warnings ?? 0) > 0 || (d.max_same_tool_streak ?? 0) >= 6;
    }).length;
    const stuckEvidence = [
      ...(sig.stuckStops ? [`${sig.stuckStops} stuck-stop(s) (repetition/error-spiral) in window`] : []),
      ...(ceilingStuck ? [`${ceilingStuck} ceiling run(s) show drift warnings/streaks in their receipts`] : []),
      ...(sig.maxStreak >= 6 ? [`max same-tool streak ${sig.maxStreak} in window`] : []),
    ];
    findings.push({ metric: "budget_ceiling", value: `${maxStepsHits}/${n} hit max_steps/wall`, detail: "loop routinely runs out of room" });
    if (stuckEvidence.length) {
      suggestions.push({
        finding: "chronic max_steps",
        symptom: `${maxStepsHits}/${n} runs hit the ceiling, but trajectories look stuck`,
        hypotheses: [{
          cause: "stuck trajectories (looping/wandering), not a low ceiling",
          confidence: sig.withReceipts ? "high" : "medium",
          evidence: stuckEvidence,
        }],
        patch: null,
        rationale: "do NOT raise the ceiling — a stuck loop burns whatever budget it gets. Review the system prompt and tool set (narrow tools, add worked examples); check drift warnings in recent receipts",
        confidence: sig.withReceipts ? "high" : "medium",
      });
    } else {
      const healthy = sig.withReceipts > 0 && sig.evidenced > 0;
      suggestions.push({
        finding: "chronic max_steps",
        symptom: `${maxStepsHits}/${n} runs hit the ceiling with ${healthy ? "healthy" : "unknown"} trajectories`,
        hypotheses: [{
          cause: healthy ? "ceiling too low for genuine multi-step work" : "ceiling too low (trajectory health unknown — no receipts)",
          confidence: healthy ? "high" : "low",
          evidence: healthy
            ? [`${sig.evidenced} run(s) gathered verification evidence`, `no drift warnings in window`, `p90 steps ${p90} vs ceiling ${current}`]
            : [`${maxStepsHits} ceiling hits`, "no receipts to judge trajectory health — receipts started with the evidence/drift rollout"],
        }],
        patch: { limits: { max_steps: proposed } },
        rationale: `raise max_steps ${current} -> ${proposed} (p90 steps ${p90})${healthy ? "" : "; LOW confidence — inspect whether runs loop before applying"}`,
        confidence: healthy ? "high" : "low",
      });
    }
  }

  // High unverified rate → enforce verification. Direct metric-to-cause link:
  // claims without evidence means the gate is permissive, so confidence is high.
  const unverifiedRate = unverified / n;
  if (unverified >= 2 && unverifiedRate >= 0.4 && (profile.policy?.verify_before_finish ?? "warn") !== "enforce") {
    findings.push({ metric: "unverified_rate", value: `${unverified}/${n}`, detail: "runs claiming outcomes without verification evidence" });
    suggestions.push({
      finding: "unverified outcomes",
      symptom: `${unverified}/${n} finished runs carry unverified claims`,
      hypotheses: [{
        cause: "permissive verification gate (warn/off lets claims through)",
        confidence: "high",
        evidence: [`${unverified} unverified finishes in window of ${n}`],
      }],
      patch: { policy: { verify_before_finish: "enforce" } },
      rationale: "require verification evidence before finish is accepted",
      confidence: "high",
    });
  }

  // Repeated looping → the model is stuck, not the budget. No patch exists at
  // the config level for a reasoning failure — the intervention is prompt/tools.
  if (repetitions >= 2) {
    findings.push({ metric: "repetition_rate", value: `${repetitions}/${n}`, detail: "runs halted on identical repeated calls" });
    suggestions.push({
      finding: "repetition",
      symptom: `${repetitions}/${n} runs halted on identical repeated calls`,
      hypotheses: [
        { cause: "prompt/tool mismatch — the model repeats instead of progressing", confidence: "medium", evidence: [`${repetitions} repetition_detected halts`] },
        { cause: "missing tool for the actual subtask (model stalls on the closest match)", confidence: "low", evidence: ["no direct signal — check which tool repeats in the ledger"] },
      ],
      patch: null,
      rationale: "review the profile system prompt and tool set — the model repeats instead of progressing; consider narrowing tools or adding worked examples to system",
      confidence: "medium",
    });
  }

  // Cost pressure → tighten budget or cheaper model. Ambiguous by nature: cost
  // alone cannot say whether the spend was worth it.
  const medCost = median(costs);
  const maxUsd = Number(limits.max_usd ?? 0.5);
  if (medCost >= maxUsd * 0.8 && n >= 3) {
    findings.push({ metric: "cost_pressure", value: `median $${medCost.toFixed(4)} vs max $${maxUsd}`, detail: "typical run nears the per-run ceiling" });
    suggestions.push({
      finding: "cost pressure",
      symptom: `median run costs $${medCost.toFixed(4)} against a $${maxUsd} ceiling`,
      hypotheses: [
        { cause: "ceiling set below genuine task cost", confidence: "medium", evidence: [`median ${median(steps)} steps per run`] },
        { cause: "expensive model for routine objectives", confidence: "low", evidence: ["cost alone cannot judge value — compare outcomes"] },
      ],
      patch: null,
      rationale: "either raise max_usd (if outcomes justify it) or switch to a cheaper model id for routine objectives",
      confidence: "medium",
    });
  }

  // Provider failures → add a fallback, but ONLY one the operator can actually
  // serve: a fallback without a credential is decoration. Latency, cost, and
  // jurisdiction are not assessed here — the rationale says so.
  if (modelErrors >= 2 && !profile.model?.fallback) {
    findings.push({ metric: "provider_failures", value: `${modelErrors}/${n}`, detail: "runs dying on model/provider errors" });
    const pick = pickFallback();
    if (pick) {
      suggestions.push({
        finding: "provider fragility",
        symptom: `${modelErrors}/${n} runs died on model/provider errors with no fallback configured`,
        hypotheses: [{
          cause: "single provider dependency",
          confidence: "high",
          evidence: [`${modelErrors} model_error/no_provider stops`, `${pick.provider} credential visible via ${pick.via}`],
        }],
        patch: { model: { fallback: { provider: pick.provider, id: pick.id } } },
        rationale: `add a fallback provider so one outage does not kill runs (credential present via ${pick.via}; latency/cost/jurisdiction NOT assessed — confirm before production use)`,
        confidence: "medium",
      });
    } else {
      suggestions.push({
        finding: "provider fragility",
        symptom: `${modelErrors}/${n} runs died on model/provider errors with no fallback configured`,
        hypotheses: [{
          cause: "single provider dependency with no visible alternative credential",
          confidence: "high",
          evidence: [`${modelErrors} model_error/no_provider stops`, "no OPENROUTER/OPENAI/ANTHROPIC/GROQ key in env (sync check only)"],
        }],
        patch: null,
        rationale: "no fallback credential detected — set one of OPENROUTER_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / GROQ_API_KEY, or run a local model, then add it as model.fallback",
        confidence: "medium",
      });
    }
  }

  return { profile: profileName, runs: n, findings, suggestions };
}

export async function recordAnalysis(profileName, analysis, organismId = "default") {
  try {
    const summary = `harness analysis ${profileName}: ${analysis.runs} runs, ` +
      analysis.findings.map((f) => `${f.metric}=${typeof f.value === "object" ? JSON.stringify(f.value) : f.value}`).join("; ");
    const r = await adamCall("adam_beliefs", { statement: summary, origin: "observation" }, organismId);
    return r._adam === "ok";
  } catch { return false; }
}