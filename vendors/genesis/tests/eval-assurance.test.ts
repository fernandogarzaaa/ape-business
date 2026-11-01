/**
 * Milestone 3: evaluator assurance + combined trust.
 * Dataset-derived probes, the RLVR suite bridge, and the trust decision matrix.
 */

import { describe, expect, it } from "vitest";

import {
  assureEvaluator, auditSpecEvaluatorAgainstSuite, decideTrust,
  renderAssurance, renderTrust,
} from "../src/eval/assurance.js";
import { runExperiment } from "../src/eval/runner.js";
import { loadSpecFile } from "../src/eval/spec.js";

describe("assurance probes", () => {
  it("brands the classification evaluator SOUND with brittleness notes", async () => {
    const a = await assureEvaluator(loadSpecFile("examples/classification/evaluation.yaml"));
    expect(a.verdict).toBe("SOUND");
    expect(a.controls).toBe(8);
    expect(a.false_accept_rate.point).toBe(0);
    expect(a.false_reject_rate.point).toBe(0);
    expect(a.findings.some((f) => f.severity === "brittle")).toBe(true);
    expect(a.dataset_digest).toMatch(/^sha256:/);
  }, 60_000);

  it("brands the retrieval evaluator SOUND (garbage strings are judged failures, not shrugs)", async () => {
    const a = await assureEvaluator(loadSpecFile("examples/rag/evaluation.yaml"));
    expect(a.verdict).toBe("SOUND");
    // Empty/echo outputs carry no IDs: scored 0 (reject), not abstained.
    expect(a.abstains).toBe(0);
    expect(a.findings.some((f) => f.severity === "exploitable")).toBe(false);
  }, 60_000);

  it("brands the exact evaluator SOUND on arithmetic", async () => {
    const a = await assureEvaluator(loadSpecFile("examples/arithmetic/evaluation.yaml"));
    expect(a.verdict).toBe("SOUND");
  }, 60_000);

  it("withholds verdict when the dataset carries no gold outputs", async () => {
    const a = await assureEvaluator({
      name: "goldless",
      dataset: { inline: [{ input: "x" }, { input: "y" }] },
      subject: { inline: "echo" },
      evaluator: { type: "exact" },
    });
    expect(a.verdict).toBe("UNRELIABLE");
    expect(a.probes_run).toBe(0);
  });

  it("catches an always-accept evaluator as EXPLOITABLE", async () => {
    const a = await assureEvaluator({
      name: "gullible",
      dataset: { inline: [{ input: "a", reference: "A" }, { input: "b", reference: "B" }] },
      subject: { inline: "upper" },
      evaluator: { type: "javascript", script: "return true;" },
    });
    expect(a.verdict).toBe("EXPLOITABLE");
    expect(a.false_accept_rate.point).toBeGreaterThan(0);
    expect(a.findings.some((f) => f.severity === "exploitable")).toBe(true);
  });

  it("catches an always-reject evaluator as OVER_STRICT", async () => {
    const a = await assureEvaluator({
      name: "harsh",
      dataset: { inline: [{ input: "a", reference: "A" }, { input: "b", reference: "B" }] },
      subject: { inline: "upper" },
      evaluator: { type: "javascript", script: "return false;" },
    });
    expect(a.verdict).toBe("OVER_STRICT");
    expect(a.false_reject_rate.point).toBeGreaterThan(0);
  });

  it("renders a report answering the trust questions", async () => {
    const a = await assureEvaluator(loadSpecFile("examples/arithmetic/evaluation.yaml"));
    const text = renderAssurance(a);
    expect(text).toContain("EVALUATOR VERDICT: SOUND");
    expect(text).toContain("False-accept");
    expect(text).toContain("SCOPE:");
  }, 60_000);
});

describe("suite bridge", () => {
  it("audits the exact evaluator against the math suite: EXPLOITABLE + OVER_STRICT", async () => {
    const record = await auditSpecEvaluatorAgainstSuite(
      loadSpecFile("examples/arithmetic/evaluation.yaml"),
      "math",
    );
    // Bare "42" is accepted despite the missing \boxed{} marker; marked
    // correct answers are rejected. Both directions are real findings.
    expect(record.conclusion.verdict).toBe("EXPLOITABLE");
    expect(record.conclusion.metrics.exploitable_classes).toContain("missing_markers");
    expect(record.results.length).toBeGreaterThan(0);
  }, 60_000);

  it("rejects unknown suites without running anything", async () => {
    await expect(
      auditSpecEvaluatorAgainstSuite(loadSpecFile("examples/arithmetic/evaluation.yaml"), "nope"),
    ).rejects.toThrow('unknown suite "nope"');
  });
});

describe("trust decisions", () => {
  it("trusts positive and negative results under a sound evaluator", () => {
    expect(decideTrust("SUPPORTED", "SOUND").trust).toBe("TRUSTED");
    const neg = decideTrust("FALSIFIED", "SOUND");
    expect(neg.trust).toBe("TRUSTED");
    expect(neg.reasons.join(" ")).toContain("negative result");
  });

  it("distrusts everything under an exploitable evaluator", () => {
    for (const system of ["SUPPORTED", "FALSIFIED", "INCONCLUSIVE"] as const) {
      const t = decideTrust(system, "EXPLOITABLE");
      expect(t.trust).toBe("UNTRUSTED");
    }
  });

  it("withholds trust for unreliable/over-strict evaluators and invalid specs", () => {
    expect(decideTrust("SUPPORTED", "UNRELIABLE").trust).toBe("INCONCLUSIVE");
    expect(decideTrust("SUPPORTED", "OVER_STRICT").trust).toBe("INCONCLUSIVE");
    expect(decideTrust("INVALID", "SOUND").trust).toBe("INCONCLUSIVE");
    expect(decideTrust("INCONCLUSIVE", "SOUND").trust).toBe("INCONCLUSIVE");
  });

  it("runs the full loop: evaluate → assure → trust", async () => {
    const spec = loadSpecFile("examples/classification/evaluation.yaml");
    const experiment = await runExperiment(spec);
    const assurance = await assureEvaluator(spec);
    const trust = decideTrust(experiment.verdict.verdict, assurance.verdict);
    expect(trust.trust).toBe("TRUSTED");
    const text = renderTrust(spec.name, experiment.verdict.summary, assurance, trust);
    expect(text).toContain("TRUST: TRUSTED");
    expect(text).toContain("EVALUATOR VERDICT: SOUND");
  }, 120_000);

  it("an exploitable evaluator poisons even a SUPPORTED system", async () => {
    const spec = loadSpecFile("examples/classification/evaluation.yaml");
    const experiment = await runExperiment(spec);
    expect(experiment.verdict.verdict).toBe("SUPPORTED");
    // Same system verdict, gullible judge: trust must collapse.
    const gullible = await assureEvaluator({
      name: "gullible",
      dataset: { inline: [{ input: "a", reference: "A" }, { input: "b", reference: "B" }] },
      subject: { inline: "upper" },
      evaluator: { type: "javascript", script: "return true;" },
    });
    expect(decideTrust(experiment.verdict.verdict, gullible.verdict).trust).toBe("UNTRUSTED");
  }, 120_000);
});
