/**
 * Probes: the adversarial inputs an audit fires at a verifier.
 *
 * A probe pairs a task with a candidate completion and states what a *correct*
 * verifier must do with it. Two kinds, and both are mandatory:
 *
 *   - **exploit probes** (`expect: "reject"`) — a completion that satisfies the
 *     defect but not the task. A verifier that accepts one has the defect.
 *   - **control probes** (`expect: "accept"`) — a genuinely correct completion.
 *
 * Controls are not optional garnish. Without them a verifier that rejects
 * everything scores a perfect zero false-accept rate while being useless. This
 * is the same tension the acceptance layer met as coverage-versus-false-ship,
 * and it has the same resolution: report both rates, never one.
 *
 * A suite is content-addressed. An audit result is meaningless unless it names
 * which probes produced it, so the suite digest is recorded with every finding.
 */

import { hashCanonical } from "../shared/canonical.js";
import type { DefectClass, Domain } from "./taxonomy.js";
import type { BehavioralDefectClass, BehavioralDomain } from "./behavioral-taxonomy.js";

/**
 * The union across every registered taxonomy. `taxonomy.ts` (Ray, RLVR
 * verifiers) and `behavioral-taxonomy.ts` (this project, behavioral oracles)
 * are kept as separate, independently citable tables; probes and suites are
 * typed generically over their union so the same machinery — validation,
 * adjudication, reporting, ledger recording — serves both without either
 * table needing to know the other exists.
 */
export type AnyDomain = Domain | BehavioralDomain;
export type AnyDefectClass = DefectClass | BehavioralDefectClass;

export interface ProbeTask {
  /** What the agent was asked to do. Passed to the verifier as the task spec. */
  readonly prompt: string;
  /** Reference answer, for domains where the verifier compares against one. */
  readonly reference?: string;
  /** Tests the agent could see. Code domain. */
  readonly visible_tests?: readonly string[];
  /** Held-out tests. A correct verifier runs these; a defective one does not. */
  readonly hidden_tests?: readonly string[];
  /** Expected call shape. JSON domain. */
  readonly schema?: Record<string, unknown>;
  /** Behavioral domain: the app under simulation and who is operating it. */
  readonly url?: string;
  readonly persona?: string;
  readonly goal?: string;
  readonly seed?: number | string;
}

export interface Probe {
  readonly id: string;
  readonly defect_class: AnyDefectClass;
  readonly domain: AnyDomain;
  readonly task: ProbeTask;
  /** The candidate the verifier must judge. */
  readonly completion: string;
  /** What a correct verifier must do. */
  readonly expect: "accept" | "reject";
  /** Why this probe is diagnostic. Appears in findings. */
  readonly rationale: string;
}

export interface ProbeSuite {
  readonly name: string;
  readonly version: string;
  readonly domain: AnyDomain;
  readonly probes: readonly Probe[];
}

/** Content hash over the suite. Recorded with every audit. */
export function suiteDigest(suite: ProbeSuite): string {
  return hashCanonical(suite as unknown as Record<string, unknown>);
}

export function exploitProbes(suite: ProbeSuite): Probe[] {
  return suite.probes.filter((p) => p.expect === "reject");
}

export function controlProbes(suite: ProbeSuite): Probe[] {
  return suite.probes.filter((p) => p.expect === "accept");
}

/**
 * A suite is only diagnostic if every defect class it claims to test has at
 * least one exploit probe, and the suite as a whole has at least one control.
 * Checked before every audit — an audit run against a malformed suite would
 * report clean results for defects it never probed.
 */
export function validateSuite(suite: ProbeSuite): string[] {
  const errors: string[] = [];

  if (suite.probes.length === 0) {
    errors.push("suite contains no probes");
    return errors;
  }

  if (controlProbes(suite).length === 0) {
    errors.push(
      "suite has no control probes; without them a verifier that rejects everything " +
        "scores a perfect false-accept rate while being useless",
    );
  }

  const ids = new Set<string>();
  for (const probe of suite.probes) {
    if (ids.has(probe.id)) errors.push(`duplicate probe id "${probe.id}"`);
    ids.add(probe.id);

    if (probe.domain !== suite.domain) {
      errors.push(`probe "${probe.id}" is domain ${probe.domain} in a ${suite.domain} suite`);
    }
  }

  const claimed = new Set(exploitProbes(suite).map((p) => p.defect_class));
  for (const probe of suite.probes) {
    if (probe.expect === "reject" && !claimed.has(probe.defect_class)) {
      errors.push(`defect class "${probe.defect_class}" has no exploit probe`);
    }
  }

  return errors;
}
