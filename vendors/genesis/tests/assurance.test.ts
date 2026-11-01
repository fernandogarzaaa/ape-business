import { describe, expect, it } from "vitest";
import { runAudit, AuditError, exitCodeFor } from "../src/assurance/audit.js";
import { classifyOutcome, concludeAudit, type ProbeResult } from "../src/assurance/findings.js";
import { suiteDigest, validateSuite, type ProbeSuite } from "../src/assurance/probe.js";
import { codeSuite, jsonSuite, mathSuite, suiteNames } from "../src/assurance/suites/index.js";
import { DEFECT_CLASSES, TAXONOMY } from "../src/assurance/taxonomy.js";
import { parseJsonLoose, VerifierAdapter } from "../src/assurance/verifier.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SubprocessRunner } from "../src/evidence/runner.js";
import { FakeRunner } from "./helpers.js";

const NAIVE = ["node", "fixtures/verifiers/naive.mjs", "{task_file}", "{completion_file}"];
const STRICT = ["node", "fixtures/verifiers/strict.mjs", "{task_file}", "{completion_file}"];

function adapter(command: readonly string[], name: string) {
  return new VerifierAdapter(
    { name, command, accept: { kind: "json_reward" }, timeout_ms: 15_000 },
    new SubprocessRunner(),
  );
}

function result(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    probe_id: "p1",
    defect_class: "stdout_spoofing",
    expected: "reject",
    observed: "reject",
    outcome: "correct",
    rationale: "because",
    note: null,
    duration_ms: 1,
    artifact_digest: null,
    ...overrides,
  };
}

describe("taxonomy", () => {
  it("covers all eleven defect classes from Ray's taxonomy", () => {
    expect(DEFECT_CLASSES).toHaveLength(11);
    for (const id of DEFECT_CLASSES) {
      expect(TAXONOMY[id].defect).toBeTruthy();
      expect(TAXONOMY[id].exploit).toBeTruthy();
    }
  });

  it("registers a suite per domain", () => {
    expect(suiteNames()).toEqual(["behavioral", "code", "json", "math"]);
  });
});

describe("suite validation", () => {
  it("accepts the shipped suites", () => {
    for (const suite of [codeSuite, jsonSuite, mathSuite]) {
      expect(validateSuite(suite)).toEqual([]);
    }
  });

  // Without controls, a verifier that rejects everything scores perfectly.
  it("rejects a suite with no control probes", () => {
    const suite: ProbeSuite = {
      ...codeSuite,
      probes: codeSuite.probes.filter((p) => p.expect === "reject"),
    };
    expect(validateSuite(suite).join(" ")).toContain("no control probes");
  });

  it("rejects duplicate probe ids", () => {
    const first = codeSuite.probes[0];
    if (!first) throw new Error("fixture");
    const suite: ProbeSuite = { ...codeSuite, probes: [...codeSuite.probes, first] };
    expect(validateSuite(suite).join(" ")).toContain("duplicate probe id");
  });

  it("rejects a probe from the wrong domain", () => {
    const mathProbe = mathSuite.probes[0];
    if (!mathProbe) throw new Error("fixture");
    const suite: ProbeSuite = { ...codeSuite, probes: [...codeSuite.probes, mathProbe] };
    expect(validateSuite(suite).join(" ")).toContain("domain math in a code suite");
  });

  it("digests are stable and content-addressed", () => {
    expect(suiteDigest(codeSuite)).toBe(suiteDigest({ ...codeSuite }));
    expect(suiteDigest(codeSuite)).not.toBe(suiteDigest(jsonSuite));
  });
});

describe("outcome classification", () => {
  it("accepting an exploit probe is a false accept", () => {
    expect(classifyOutcome("reject", "accept")).toBe("false_accept");
  });

  it("rejecting a control probe is a false reject", () => {
    expect(classifyOutcome("accept", "reject")).toBe("false_reject");
  });

  // A verifier that hangs on adversarial input has not errored — it has failed
  // to reject in bounded time, which is the exploitable condition.
  it("hanging on an exploit probe is a defect, not an error", () => {
    expect(classifyOutcome("reject", "unresponsive")).toBe("unresponsive");
  });

  it("hanging on a control probe is merely unreliable", () => {
    expect(classifyOutcome("accept", "unresponsive")).toBe("error");
  });
});

describe("conclusion", () => {
  it("counts a hang against the false-accept rate", () => {
    const conclusion = concludeAudit([
      result({ probe_id: "a", outcome: "unresponsive", observed: "unresponsive" }),
      result({ probe_id: "b", expected: "accept", observed: "accept" }),
    ]);
    expect(conclusion.metrics.false_accept_rate.point).toBe(1);
    expect(conclusion.verdict).toBe("EXPLOITABLE");
  });

  it("returns SOUND when every exploit is resisted and controls pass", () => {
    const conclusion = concludeAudit([
      result({ probe_id: "a" }),
      result({ probe_id: "b", expected: "accept", observed: "accept" }),
    ]);
    expect(conclusion.verdict).toBe("SOUND");
    expect(conclusion.findings).toHaveLength(0);
  });

  // The degenerate verifier that rejects everything must not score as sound.
  it("returns OVER_STRICT when controls are rejected", () => {
    const conclusion = concludeAudit([
      result({ probe_id: "a" }),
      result({ probe_id: "b", expected: "accept", observed: "reject", outcome: "false_reject" }),
    ]);
    expect(conclusion.verdict).toBe("OVER_STRICT");
    expect(conclusion.findings.some((f) => f.severity === "over_strict")).toBe(true);
  });

  it("withholds a verdict when no controls were run", () => {
    const conclusion = concludeAudit([result({ probe_id: "a" })]);
    expect(conclusion.verdict).toBe("UNRELIABLE");
    expect(conclusion.rationale.join(" ")).toContain("rejects everything");
  });

  it("returns UNRELIABLE when the verifier mostly cannot be read", () => {
    const conclusion = concludeAudit([
      result({ probe_id: "a", outcome: "error", observed: "error" }),
      result({ probe_id: "b", outcome: "error", observed: "error" }),
      result({ probe_id: "c", expected: "accept", observed: "accept" }),
    ]);
    expect(conclusion.verdict).toBe("UNRELIABLE");
  });

  it("is invariant to probe result ordering", () => {
    const a = result({ probe_id: "a", outcome: "false_accept", observed: "accept" });
    const b = result({ probe_id: "b", expected: "accept", observed: "accept" });
    expect(JSON.stringify(concludeAudit([a, b]))).toBe(JSON.stringify(concludeAudit([b, a])));
  });

  it("groups findings by defect class and cites the probes", () => {
    const conclusion = concludeAudit([
      result({ probe_id: "a", defect_class: "stdout_spoofing", outcome: "false_accept", observed: "accept" }),
      result({ probe_id: "b", defect_class: "stdout_spoofing", outcome: "false_accept", observed: "accept" }),
      result({ probe_id: "c", expected: "accept", observed: "accept" }),
    ]);
    expect(conclusion.findings).toHaveLength(1);
    expect(conclusion.findings[0]?.evidence.map((e) => e.probe_id)).toEqual(["a", "b"]);
  });
});

describe("verifier adapter", () => {
  it("reads a reward field from noisy stdout", async () => {
    const runner = new FakeRunner({}, { stdout: 'progress...\n{"reward": 1}\ndone' });
    const probe = codeSuite.probes[0];
    if (!probe) throw new Error("fixture");

    const response = await new VerifierAdapter(
      { name: "t", command: ["x", "{task_file}", "{completion_file}"], accept: { kind: "json_reward" }, timeout_ms: 100 },
      runner,
    ).judge(probe);

    expect(response.observed).toBe("accept");
    expect(response.raw_reward).toBe(1);
  });

  it("reports unresponsive rather than error on timeout", async () => {
    const runner = new FakeRunner({}, { timed_out: true, exit_code: null });
    const probe = codeSuite.probes[0];
    if (!probe) throw new Error("fixture");

    const response = await new VerifierAdapter(
      { name: "t", command: ["x", "{task_file}", "{completion_file}"], accept: { kind: "exit_zero" }, timeout_ms: 10 },
      runner,
    ).judge(probe);

    expect(response.observed).toBe("unresponsive");
  });

  it("substitutes both file placeholders", async () => {
    const runner = new FakeRunner({}, { stdout: '{"reward":0}' });
    const probe = codeSuite.probes[0];
    if (!probe) throw new Error("fixture");

    await new VerifierAdapter(
      { name: "t", command: ["x", "{task_file}", "{completion_file}"], accept: { kind: "json_reward" }, timeout_ms: 100 },
      runner,
    ).judge(probe);

    const call = runner.calls[0];
    expect(call?.command[1]).toContain("task.json");
    expect(call?.command[2]).toContain("completion.txt");
  });

  it("parses JSON embedded in surrounding output", () => {
    expect(parseJsonLoose('noise {"reward":1} noise')).toEqual({ reward: 1 });
    expect(parseJsonLoose("not json at all")).toBeNull();
  });
});

describe("audit runner", () => {
  it("refuses to run a non-diagnostic suite", async () => {
    const suite: ProbeSuite = { ...codeSuite, probes: [] };
    await expect(
      runAudit({ verifier: adapter(STRICT, "s"), suite }),
    ).rejects.toThrow(AuditError);
  });

  it("maps verdicts to distinct exit codes", () => {
    expect(exitCodeFor("SOUND")).toBe(0);
    expect(exitCodeFor("EXPLOITABLE")).toBe(1);
    expect(exitCodeFor("UNRELIABLE")).toBe(2);
  });
});

// ── The demo that establishes the probes actually discriminate ──────────────
//
// A probe suite that flags everything is worthless, and so is one that flags
// nothing. These run the real fixture verifiers as subprocesses.

describe("end to end: a defective verifier is caught", () => {
  it("finds every planted defect in the code harness", async () => {
    const ledger = new Ledger(":memory:");
    const record = await runAudit({ verifier: adapter(NAIVE, "naive"), suite: codeSuite, ledger });

    expect(record.conclusion.verdict).toBe("EXPLOITABLE");
    expect(record.conclusion.metrics.false_accept_rate.point).toBe(1);
    expect([...record.conclusion.metrics.exploitable_classes].sort()).toEqual([
      "missing_timeouts",
      "stdout_spoofing",
      "visible_test_overfitting",
    ]);
    ledger.close();
  }, 120_000);

  it("finds every planted defect in the json harness", async () => {
    const record = await runAudit({ verifier: adapter(NAIVE, "naive"), suite: jsonSuite });
    expect(record.conclusion.verdict).toBe("EXPLOITABLE");
    expect(record.conclusion.metrics.exploitable_classes.length).toBe(4);
  }, 60_000);

  it("finds every planted defect in the math harness", async () => {
    const record = await runAudit({ verifier: adapter(NAIVE, "naive"), suite: mathSuite });
    expect(record.conclusion.verdict).toBe("EXPLOITABLE");
    expect(record.conclusion.metrics.exploitable_classes.length).toBe(4);
  }, 60_000);
});

describe("end to end: a sound verifier is not slandered", () => {
  for (const [name, suite] of [
    ["code", codeSuite],
    ["json", jsonSuite],
    ["math", mathSuite],
  ] as const) {
    it(`clears the strict harness on ${name}, with zero false rejects`, async () => {
      const record = await runAudit({ verifier: adapter(STRICT, "strict"), suite });

      expect(record.conclusion.verdict).toBe("SOUND");
      expect(record.conclusion.metrics.false_accept_rate.point).toBe(0);
      // The control probes are the point: a verifier that rejected them would
      // score a perfect false-accept rate while being useless.
      expect(record.conclusion.metrics.false_reject_rate.point).toBe(0);
      expect(record.conclusion.findings).toEqual([]);
    }, 120_000);
  }
});

describe("ledger integration", () => {
  it("records the audit and keeps the chain intact", async () => {
    const ledger = new Ledger(":memory:");
    const record = await runAudit({ verifier: adapter(STRICT, "strict"), suite: mathSuite, ledger });

    const entries = ledger.entries({ type: "VERIFIER_AUDITED" });
    expect(entries).toHaveLength(1);
    expect(record.ledger_entry).toBe(entries[0]?.entry_hash);
    expect(ledger.verifyChain().ok).toBe(true);
    ledger.close();
  }, 60_000);

  it("stores a retrievable transcript for every probe", async () => {
    const ledger = new Ledger(":memory:");
    const record = await runAudit({ verifier: adapter(NAIVE, "naive"), suite: mathSuite, ledger });

    for (const probeResult of record.results) {
      expect(probeResult.artifact_digest).toBeTruthy();
      const transcript = ledger.getArtifact(probeResult.artifact_digest ?? "");
      expect(transcript).toContain(probeResult.probe_id);
      expect(transcript).toContain("--- completion ---");
    }
    ledger.close();
  }, 60_000);

  it("records the suite digest so a result names the probes that produced it", async () => {
    const ledger = new Ledger(":memory:");
    await runAudit({ verifier: adapter(STRICT, "strict"), suite: mathSuite, ledger });

    const payload = ledger.entries({ type: "VERIFIER_AUDITED" })[0]?.payload as {
      suite_digest: string;
    };
    expect(payload.suite_digest).toBe(suiteDigest(mathSuite));
    ledger.close();
  }, 60_000);
});
