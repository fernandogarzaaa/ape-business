/**
 * Genesis evaluation domain model.
 *
 * Universal hierarchy:
 *
 *   Evaluation
 *   ├── Claim          — what someone wants to establish empirically
 *   ├── Specification  — machine-readable plan compiled from the claim
 *   ├── Subject        — the system under test (via adapter, never SDK-locked)
 *   ├── Baseline       — what the candidate is compared against
 *   ├── Dataset        — immutable, versioned, digested task population
 *   ├── Task           — one unit of work
 *   ├── Trial          — one execution of one task (repetitions × seeds)
 *   ├── Observation    — what was observed (never confused with the claim)
 *   ├── Evidence       — observation + provenance + digest
 *   ├── Metric         — composable measurement over trials
 *   ├── Evaluator      — deterministic / reference / LLM / human / oracle / composite
 *   ├── Finding        — actionable failure/success explanation
 *   ├── StatisticalResult — estimates with method, assumptions, uncertainty
 *   └── Verdict        — SUPPORTED | FALSIFIED | INCONCLUSIVE | INVALID | UNTESTED
 *
 * Evaluator-assurance verdicts (SOUND | EXPLOITABLE | UNRELIABLE | OVER_STRICT)
 * live in `src/assurance/findings.ts` and are deliberately NOT merged here:
 * a verdict about a system and a verdict about an evaluator are different
 * claims with different evidence. They interoperate via `evaluatorAudit`
 * references on findings, not via a shared enum.
 */

export type EvaluationVerdict =
  | "SUPPORTED"
  | "FALSIFIED"
  | "INCONCLUSIVE"
  | "INVALID"
  | "UNTESTED";

export type EvaluatorKind =
  | "deterministic"
  | "reference"
  | "llm"
  | "human"
  | "oracle"
  | "composite"
  | "behavioral";

export type TaskKind =
  | "reference-based"
  | "reference-free"
  | "execution-based"
  | "behavioral"
  | "human-judged"
  | "llm-judged"
  | "oracle-based";

export interface ClaimHypothesis {
  readonly metric: string;
  readonly operator: ">=" | "<=" | ">" | "<" | "==" | "!=";
  readonly threshold: number;
}

export interface Claim {
  readonly id: string;
  readonly statement: string;
  readonly status: EvaluationVerdict;
  readonly hypothesis?: {
    readonly primary: ClaimHypothesis;
    readonly secondary?: readonly ClaimHypothesis[];
  };
  readonly population?: {
    readonly dataset: string;
    readonly version?: string;
    readonly distribution?: "in-distribution" | "out-of-distribution" | "adversarial" | "edge" | "production" | "synthetic" | "historical";
  };
  readonly baseline?: { readonly name: string };
  readonly treatment?: { readonly name: string };
  readonly methodology?: {
    readonly paired?: boolean;
    readonly repetitions?: number;
    readonly minimum_samples?: number;
    readonly seeds?: readonly (number | string)[];
  };
  readonly evaluation?: { readonly metrics: readonly string[] };
  readonly conclusion_policy?: {
    readonly insufficient_evidence?: EvaluationVerdict;
  };
}

/** A task: one unit of work. Reference answers are optional. */
export interface EvalTask {
  readonly id: string;
  readonly input: unknown;
  readonly context?: unknown;
  readonly expected?: unknown;
  readonly reference?: unknown;
  readonly constraints?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly tags?: readonly string[];
  readonly kind?: TaskKind;
  readonly evaluation_instructions?: string;
  /**
   * Ground-truth labels for classification / retrieval / structured tasks.
   * Conventions (see evaluators.ts):
   * - classification: `actual` (or top-level `reference`) holds the true class.
   * - retrieval: `relevant_ids` (also accepted under metadata/context) holds
   *   the relevant document ids.
   */
  readonly labels?: Record<string, unknown>;
}

/** Immutable dataset identity. */
export interface DatasetInfo {
  readonly id: string;
  readonly version: string;
  readonly digest: string;
  readonly task_count: number;
  readonly schema: Record<string, string>;
  readonly provenance: Record<string, unknown>;
}

/** One execution of one task. */
export interface Trial {
  readonly trial_id: string;
  readonly task_id: string;
  readonly repetition: number;
  readonly seed: number | string | null;
  readonly subject: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_ms: number;
  readonly timed_out: boolean;
  readonly error: string | null;
  readonly output: unknown;
  readonly cost?: TrialCost;
}

/** Cost accounting per trial. Never silently estimated: provider/model recorded. */
export interface TrialCost {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly estimated_usd?: number;
  readonly provider?: string;
  readonly model?: string;
}

/** Raw observation: what the evaluator decided about a trial. */
export interface Observation {
  readonly trial_id: string;
  readonly task_id: string;
  readonly evaluator: string;
  readonly evaluator_kind: EvaluatorKind;
  readonly score: number | boolean | null;
  readonly passed: boolean | null;
  readonly details?: Record<string, unknown>;
  readonly judge_model?: string;
  readonly judge_prompt_digest?: string;
}

/** Evidence: observation + provenance + digest. The traceable unit. */
export interface EvidenceRecord {
  readonly digest: string;
  readonly source: string;
  readonly timestamp: string;
  readonly task_id: string;
  readonly trial_id: string;
  readonly observation: Observation;
  readonly artifact_digest: string | null;
  readonly provenance: Record<string, unknown>;
  readonly confidence: number | null;
}

export interface MetricValue {
  readonly metric: string;
  readonly value: number;
  readonly n: number;
  readonly unit?: string;
}

export interface StatisticalResult {
  readonly metric: string;
  readonly n: number;
  readonly mean: number;
  readonly stddev: number;
  readonly median: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly ci95: { readonly low: number; readonly high: number; readonly method: string };
  readonly assumptions: readonly string[];
}

export interface PairedComparison {
  readonly metric: string;
  readonly baseline_mean: number;
  readonly treatment_mean: number;
  readonly delta: number;
  readonly relative_delta: number | null;
  readonly effect_size_cohens_d: number | null;
  readonly ci95_delta: { readonly low: number; readonly high: number; readonly method: string };
  readonly n_pairs: number;
  readonly method: string;
  readonly assumptions: readonly string[];
}

export interface EvalFinding {
  readonly category: string;
  readonly severity: "critical" | "major" | "minor" | "info";
  readonly summary: string;
  readonly evidence_digests: readonly string[];
  readonly affected_tasks: readonly string[];
  readonly reproduction?: Record<string, unknown>;
  readonly observed_behavior?: string;
  readonly expected_behavior?: string;
  readonly possible_cause?: string;
  readonly confidence: number | null;
  /** Link into evaluator-assurance when the finding implicates the evaluator. */
  readonly evaluator_audit?: { readonly verdict: string; readonly detail: string };
}

export interface VerdictRecord {
  readonly verdict: EvaluationVerdict;
  readonly claim_id: string | null;
  readonly summary: string;
  /** Claim boundaries: what was tested and what was NOT tested. */
  readonly scope: {
    readonly tested: string;
    readonly not_tested: string;
    readonly dataset: string;
    readonly dataset_digest: string;
    readonly sample_size: number;
    readonly repetitions: number;
    readonly conditions: Record<string, unknown>;
    readonly metrics: readonly string[];
    readonly uncertainty: string;
  };
  readonly hypothesis_results?: readonly {
    readonly metric: string;
    readonly operator: string;
    readonly threshold: number;
    readonly observed: number | null;
    readonly satisfied: boolean | null;
  }[];
}
