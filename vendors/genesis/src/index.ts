/**
 * Genesis — assurance infrastructure for machine-authored work.
 *
 * Audits RLVR verifiers, eval harnesses, and benchmark graders for exploitable
 * defects: fires adversarial probes at a verifier and reports which of a
 * published taxonomy's defect classes it has.
 */

export { runAudit, AuditError, AUDIT_EXIT } from "./assurance/audit.js";
export type { AuditOptions, AuditRecord } from "./assurance/audit.js";
export { concludeAudit, classifyOutcome } from "./assurance/findings.js";
export type { AuditConclusion, AuditMetrics, Finding, ProbeOutcome, ProbeResult, Severity } from "./assurance/findings.js";
export { suiteDigest, validateSuite, exploitProbes, controlProbes } from "./assurance/probe.js";
export type { Probe, ProbeSuite, ProbeTask } from "./assurance/probe.js";
export { SUITES, getSuite, suiteNames } from "./assurance/suites/index.js";
export { TAXONOMY, DEFECT_CLASSES, DOMAINS, descriptorsFor } from "./assurance/taxonomy.js";
export type { DefectClass, DefectDescriptor, Domain } from "./assurance/taxonomy.js";
export { VerifierAdapter, parseJsonLoose } from "./assurance/verifier.js";
export type { AcceptRule, Observed, VerifierConfig, VerifierResponse } from "./assurance/verifier.js";
export { renderAudit } from "./assurance/report.js";

export { Ledger, computeEntryHash } from "./ledger/ledger.js";
export type { ChainVerification, EntryType, LedgerEntry } from "./ledger/ledger.js";

export { wilson, formatInterval } from "./backtest/metrics.js";
export type { Interval } from "./backtest/metrics.js";

export { computeEnvDigest, SubprocessRunner } from "./evidence/runner.js";
export type { Runner, RunResult } from "./evidence/runner.js";

export { canonicalize, hashCanonical, sha256, ZERO_HASH } from "./shared/canonical.js";
export { redact, registerSecret } from "./shared/redact.js";

// ── Universal evaluation & assurance platform ─────────────────────────────
export type {
  EvaluationVerdict, EvaluatorKind, TaskKind, Claim, ClaimHypothesis,
  EvalTask, DatasetInfo, Trial, TrialCost, Observation, EvidenceRecord,
  MetricValue, StatisticalResult, PairedComparison, EvalFinding, VerdictRecord,
} from "./eval/types.js";
export { validateClaim, checkHypothesis, ClaimError } from "./eval/claim.js";
export { loadSpecFile, parseSpec, validateSpec, SpecError } from "./eval/spec.js";
export type { EvalSpec, SubjectSpec, EvaluatorSpec } from "./eval/spec.js";
export { loadDataset, fromRecords, DatasetError } from "./eval/dataset.js";
export { createSubject, InlineSubject, CommandSubject, HttpSubject } from "./eval/subjects.js";
export { createEvaluator } from "./eval/evaluators.js";
export { registerMetric, metricNames, computeMetric, classificationMetrics, rocAuc, prAuc, expectedCalibrationError, retrievalF1, retrievalTrialStats, trialRetrievalValues, trialDetailValues } from "./eval/metrics.js";
export { idList, retrievalPR } from "./eval/evaluators.js";
export { describe, describeRate, pairedCompare, bootstrapMeanCI, parseThreshold, checkThreshold } from "./eval/stats.js";
export { runExperiment } from "./eval/runner.js";
export type { ExperimentResult, ArmResult } from "./eval/runner.js";
export { decideVerdict } from "./eval/verdict.js";
export { buildManifest, writeEvidenceBundle, readEvidenceBundle, GENESIS_VERSION } from "./eval/bundle.js";
export { renderReport } from "./eval/report.js";
export { compareBundles, renderComparison, checkRegression } from "./eval/compare.js";
export {
  assureEvaluator, auditSpecEvaluatorAgainstSuite, decideTrust,
  renderAssurance, renderTrust,
} from "./eval/assurance.js";
export type {
  AssuranceVerdict, AssuranceProbe, AssuranceProbeResult, AssuranceFinding,
  EvaluatorAssurance, TrustVerdict, TrustJudgment,
} from "./eval/assurance.js";
export {
  resolveRegistry, listBenchmarks, loadBenchmark, resolveBenchmarkDataset,
  BenchmarkError,
} from "./eval/benchmarks.js";
export type { BenchmarkInfo } from "./eval/benchmarks.js";
export { createMcpServer, runMcpServer } from "./mcp/server.js";
export { decideGate, renderGate } from "./eval/gate.js";
export type { GateDecision, GateBreach, GateResult } from "./eval/gate.js";
export {
  generateKeypair, fingerprint, digestBundle, attestBundle, verifyBundle,
} from "./eval/attest.js";
export type { Attestation, AttestationCheck, BundleVerification } from "./eval/attest.js";
