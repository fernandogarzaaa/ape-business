/**
 * Claim-first evaluation: parse, validate, and compile claims.
 *
 * A claim is what someone wants to establish empirically. It compiles to an
 * evaluation plan; it never executes anything itself. Invalid claims are
 * INVALID (a verdict about the claim), never silently coerced.
 */

import type { Claim, ClaimHypothesis } from "./types.js";

export class ClaimError extends Error {
  override readonly name = "ClaimError";
}

const OPERATORS = new Set([">=", "<=", ">", "<", "==", "!="]);

export function validateClaim(raw: unknown): { claim: Claim; problems: string[] } {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { claim: { id: "invalid", statement: "", status: "INVALID" }, problems: ["claim must be an object"] };
  }
  const c = raw as Record<string, unknown>;
  const id = typeof c.id === "string" && c.id.length > 0 ? (c.id as string) : null;
  if (!id) problems.push('claim.id is required (string)');
  const statement = typeof c.statement === "string" ? (c.statement as string) : "";
  if (!statement) problems.push("claim.statement is required (string)");

  const hypothesis = c.hypothesis as Record<string, unknown> | undefined;
  if (hypothesis !== undefined) {
    const primary = hypothesis.primary as Record<string, unknown> | undefined;
    if (!primary) problems.push("claim.hypothesis.primary is required when hypothesis is present");
    else validateHypothesis(primary, "primary", problems);
    const secondary = hypothesis.secondary;
    if (secondary !== undefined) {
      const list = Array.isArray(secondary) ? secondary : [secondary];
      for (const [i, h] of list.entries()) validateHypothesis(h, `secondary[${i}]`, problems);
    }
  }

  const methodology = c.methodology as Record<string, unknown> | undefined;
  if (methodology !== undefined) {
    const reps = methodology.repetitions;
    if (reps !== undefined && (!Number.isInteger(reps) || (reps as number) < 1)) {
      problems.push("claim.methodology.repetitions must be an integer >= 1");
    }
    const min = methodology.minimum_samples;
    if (min !== undefined && (!Number.isInteger(min) || (min as number) < 1)) {
      problems.push("claim.methodology.minimum_samples must be an integer >= 1");
    }
  }

  const claim: Claim = {
    id: id ?? "invalid",
    statement,
    status: "UNTESTED",
    ...(hypothesis?.primary ? { hypothesis: normalizeHypothesis(c) } : {}),
    ...(c.population ? { population: c.population as Claim["population"] } : {}),
    ...(c.baseline ? { baseline: c.baseline as Claim["baseline"] } : {}),
    ...(c.treatment ? { treatment: c.treatment as Claim["treatment"] } : {}),
    ...(methodology ? { methodology: methodology as Claim["methodology"] } : {}),
    ...(c.evaluation ? { evaluation: c.evaluation as Claim["evaluation"] } : {}),
    ...(c.conclusion_policy ? { conclusion_policy: c.conclusion_policy as Claim["conclusion_policy"] } : {}),
  };
  return { claim, problems };
}

function validateHypothesis(h: unknown, where: string, problems: string[]): void {
  if (!h || typeof h !== "object") {
    problems.push(`claim.hypothesis.${where} must be an object`);
    return;
  }
  const hh = h as Record<string, unknown>;
  if (typeof hh.metric !== "string" || !hh.metric) problems.push(`claim.hypothesis.${where}.metric is required`);
  if (!OPERATORS.has(hh.operator as string)) problems.push(`claim.hypothesis.${where}.operator must be one of >=, <=, >, <, ==, !=`);
  if (typeof hh.threshold !== "number" || !Number.isFinite(hh.threshold)) {
    problems.push(`claim.hypothesis.${where}.threshold must be a finite number`);
  }
}

function normalizeHypothesis(c: Record<string, unknown>): NonNullable<Claim["hypothesis"]> {
  const h = c.hypothesis as Record<string, unknown>;
  const primary = h.primary as Record<string, unknown>;
  const secondary = h.secondary;
  const list = secondary === undefined ? [] : Array.isArray(secondary) ? secondary : [secondary];
  return {
    primary: primary as unknown as ClaimHypothesis,
    ...(list.length > 0 ? { secondary: list as unknown as ClaimHypothesis[] } : {}),
  };
}

/** Evaluate one hypothesis against an observed value. Null observed → null (INCONCLUSIVE). */
export function checkHypothesis(
  h: ClaimHypothesis,
  observed: number | null,
): boolean | null {
  if (observed === null || !Number.isFinite(observed)) return null;
  switch (h.operator) {
    case ">=": return observed >= h.threshold;
    case "<=": return observed <= h.threshold;
    case ">": return observed > h.threshold;
    case "<": return observed < h.threshold;
    case "==": return observed === h.threshold;
    case "!=": return observed !== h.threshold;
  }
}
