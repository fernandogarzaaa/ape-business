/**
 * Reproducibility manifest + exportable evidence bundle.
 *
 * experiment/
 * ├── manifest.json      — genesis version, spec/dataset digests, env, seeds
 * ├── claim.json         — the claim (if any)
 * ├── specification.json — the evaluation spec (redacted)
 * ├── dataset.json       — dataset identity + schema
 * ├── baseline/          — results.jsonl + metrics.json (when present)
 * ├── treatment/         — results.jsonl + metrics.json
 * ├── ablations/         — per-arm results (when present)
 * ├── statistics.json    — per-arm stats + paired comparisons
 * ├── findings.json
 * ├── evidence/          — evidence.jsonl (every record, digested)
 * └── verdict.json       — verdict with claim boundaries
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "../shared/canonical.js";
import { redact } from "../shared/redact.js";
import { computeEnvDigest } from "../evidence/runner.js";
import type { ExperimentResult } from "./runner.js";
import type { EvalSpec } from "./spec.js";

export const GENESIS_VERSION = "0.2.0";

export interface Manifest {
  readonly genesis_version: string;
  readonly created_at: string;
  readonly spec_digest: string;
  readonly dataset_digest: string;
  readonly env_digest: string;
  readonly runtime: Record<string, unknown>;
  readonly seeds: readonly (number | string)[];
  readonly repetitions: number;
  readonly ledger_entry: string | null;
}

export function buildManifest(
  spec: EvalSpec,
  result: ExperimentResult,
  options: { ledgerEntry?: string | null; repoPath?: string } = {},
): Manifest {
  return {
    genesis_version: GENESIS_VERSION,
    created_at: new Date().toISOString(),
    spec_digest: result.spec_digest,
    dataset_digest: result.dataset.digest,
    env_digest: computeEnvDigest(options.repoPath ?? process.cwd()),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    seeds: spec.seeds ?? spec.claim?.methodology?.seeds ?? [1],
    repetitions: spec.repetitions ?? spec.claim?.methodology?.repetitions ?? 1,
    ledger_entry: options.ledgerEntry ?? null,
  };
}

export function writeEvidenceBundle(dir: string, spec: EvalSpec, result: ExperimentResult, manifest: Manifest): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "evidence"), { recursive: true });
  const write = (rel: string, value: unknown) => {
    const text = redact(JSON.stringify(value, null, 2));
    writeFileSync(join(dir, rel), text, "utf8");
  };
  write("manifest.json", manifest);
  if (spec.claim) write("claim.json", spec.claim);
  write("specification.json", { ...spec, spec_digest: result.spec_digest });
  write("dataset.json", result.dataset);
  for (const arm of result.arms) {
    const armDir = arm.arm === "treatment"
      ? "treatment"
      : arm.arm === "baseline"
        ? "baseline"
        : join("ablations", arm.arm.replace(/^(ablation|sanity):/, "").replace(/[^A-Za-z0-9._-]+/g, "_"));
    mkdirSync(join(dir, armDir), { recursive: true });
    const lines = arm.trials.map((t) => {
      const obs = arm.observations.find((o) => o.trial_id === t.trial_id);
      return JSON.stringify({ trial: t, observation: obs });
    });
    writeFileSync(join(dir, armDir, "results.jsonl"), `${redact(lines.join("\n"))}\n`, "utf8");
    write(join(armDir, "metrics.json"), arm.metrics);
  }
  write("statistics.json", {
    arms: result.arms.map((a) => ({ arm: a.arm, statistics: a.statistics })),
    comparisons: result.comparisons,
  });
  write("findings.json", result.findings);
  const evidenceLines = result.arms.flatMap((a) => a.evidence).map((e) => JSON.stringify(e));
  writeFileSync(join(dir, "evidence", "evidence.jsonl"), `${redact(evidenceLines.join("\n"))}\n`, "utf8");
  write("verdict.json", result.verdict);
  if (spec.analysis && spec.analysis.length > 0) {
    // External cross-checks (e.g. interpretability notes): copied verbatim
    // into the bundle so the verdict cites exactly what was reviewed.
    mkdirSync(join(dir, "analysis"), { recursive: true });
    for (const file of spec.analysis) {
      const full = file;
      let content: Buffer;
      try {
        content = readFileSync(full);
      } catch {
        throw new Error(`analysis attachment not found: ${file}`);
      }
      const base = file.split(/[\\/]/).pop() as string;
      writeFileSync(join(dir, "analysis", base), content);
    }
  }
  const bundleDigest = createHash("sha256").update(canonicalize(result.verdict as unknown as Record<string, unknown>)).digest("hex");
  writeFileSync(join(dir, "DIGEST"), `sha256:${bundleDigest}\n`, "utf8");
}

export function readEvidenceBundle(dir: string): { verdict: unknown; manifest: unknown; metrics: unknown } {  return {
    verdict: JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")),
    manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
    metrics: tryRead(join(dir, "treatment", "metrics.json")),
  };
}

function tryRead(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Trust bundle: the evaluation evidence bundle plus evaluator assurance.
 *
 * <dir>/evaluation/...   (standard evidence bundle)
 * <dir>/assurance.json   (dataset-derived probes + optional suite audit)
 * <dir>/trust.json       (combined TRUSTED | UNTRUSTED | INCONCLUSIVE)
 * <dir>/gate.json        (release-gate decision, when `genesis gate` ran)
 */
export function writeTrustBundle(
  dir: string,
  spec: EvalSpec,
  result: ExperimentResult,
  manifest: Manifest,
  assurance: unknown,
  trust: unknown,
  gate?: unknown,
): void {
  writeEvidenceBundle(join(dir, "evaluation"), spec, result, manifest);
  const write = (rel: string, value: unknown) => {
    writeFileSync(join(dir, rel), redact(JSON.stringify(value, null, 2)), "utf8");
  };
  mkdirSync(dir, { recursive: true });
  write("assurance.json", assurance);
  write("trust.json", trust);
  if (gate !== undefined) write("gate.json", gate);
}
