/**
 * The audit runner: fire a probe suite at a verifier, record everything, conclude.
 *
 * Impure by necessity — it spawns processes. Everything it learns is
 * materialized into `ProbeResult[]` and handed to the pure `concludeAudit`,
 * so the conclusion is replayable from the ledger without re-running anything.
 */

import { hashCanonical } from "../shared/canonical.js";
import type { Ledger } from "../ledger/ledger.js";
import {
  classifyOutcome,
  concludeAudit,
  type AuditConclusion,
  type ProbeResult,
} from "./findings.js";
import { suiteDigest, validateSuite, type Probe, type ProbeSuite } from "./probe.js";
import type { Judge } from "./verifier.js";

export class AuditError extends Error {
  override readonly name = "AuditError";
}

export interface AuditEvents {
  onProbeStart?(probe: Probe, index: number, total: number): void;
  onProbeFinish?(result: ProbeResult): void;
}

export interface AuditRecord {
  readonly verifier: string;
  readonly suite: string;
  readonly suite_version: string;
  readonly suite_digest: string;
  readonly conclusion: AuditConclusion;
  readonly results: readonly ProbeResult[];
  readonly ledger_entry: string | null;
}

export interface AuditOptions {
  readonly verifier: Judge;
  readonly suite: ProbeSuite;
  readonly ledger?: Ledger;
  readonly events?: AuditEvents;
}

export async function runAudit(options: AuditOptions): Promise<AuditRecord> {
  const { verifier, suite, ledger, events } = options;

  const problems = validateSuite(suite);
  if (problems.length > 0) {
    throw new AuditError(
      `probe suite "${suite.name}" is not diagnostic:\n  ${problems.join("\n  ")}`,
    );
  }

  const digest = suiteDigest(suite);
  const results: ProbeResult[] = [];

  // Probes run in declared order. Sequential rather than parallel on purpose:
  // a verifier under concurrent load can time out for reasons that have nothing
  // to do with the probe, and `unresponsive` is a finding here.
  for (const [index, probe] of suite.probes.entries()) {
    events?.onProbeStart?.(probe, index + 1, suite.probes.length);

    const response = await verifier.judge(probe);
    const artifact = ledger
      ? ledger.putArtifact(transcript(probe, response.stdout, response.stderr, response.exit_code))
      : null;

    const result: ProbeResult = {
      probe_id: probe.id,
      defect_class: probe.defect_class,
      expected: probe.expect,
      observed: response.observed,
      outcome: classifyOutcome(probe.expect, response.observed),
      rationale: probe.rationale,
      note: response.note,
      duration_ms: response.duration_ms,
      artifact_digest: artifact,
    };

    results.push(result);
    events?.onProbeFinish?.(result);
  }

  const conclusion = concludeAudit(results);

  let ledgerEntry: string | null = null;
  if (ledger) {
    const entry = ledger.recordVerifierAudit(
      hashCanonical({ verifier: verifier.name, suite_digest: digest }),
      {
        verifier: verifier.name,
        verifier_meta: verifier.describe(),
        suite: suite.name,
        suite_version: suite.version,
        suite_digest: digest,
        conclusion,
        results,
      },
    );
    ledgerEntry = entry.entry_hash;
  }

  return {
    verifier: verifier.name,
    suite: suite.name,
    suite_version: suite.version,
    suite_digest: digest,
    conclusion,
    results,
    ledger_entry: ledgerEntry,
  };
}

function transcript(
  probe: Probe,
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  return [
    `probe: ${probe.id}`,
    `defect_class: ${probe.defect_class}`,
    `expect: ${probe.expect}`,
    "--- task ---",
    JSON.stringify(probe.task, null, 2),
    "--- completion ---",
    probe.completion,
    `--- verifier exit: ${exitCode ?? "null"} ---`,
    "--- stdout ---",
    stdout,
    "--- stderr ---",
    stderr,
  ].join("\n");
}

/** Exit codes, matching the acceptance CLI's discipline. */
export const AUDIT_EXIT = {
  SOUND: 0,
  EXPLOITABLE: 1,
  UNRELIABLE: 2,
  OVER_STRICT: 2,
  INTERNAL_ERROR: 3,
} as const;

export function exitCodeFor(verdict: AuditConclusion["verdict"]): number {
  return AUDIT_EXIT[verdict];
}
