/**
 * The behavioral-oracle extension: EveOracleAdapter, the behavioral taxonomy,
 * and the probe suite formalizing EVE-001
 * (docs/assurance/findings/EVE-001-goal-signal-text-match.md).
 *
 * Two tiers, the same discipline the acceptance layer's EVE adapter fix
 * established: fast mocked tests that always run in CI (no sibling repo
 * checkout assumed), plus a live-optional end-to-end block that exercises the
 * real `eve` binary when a sibling checkout is present — skipped, not faked,
 * when it isn't. A mocked test proves the plumbing; only a real run proves the
 * finding still holds.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAudit } from "../src/assurance/audit.js";
import { EveOracleAdapter } from "../src/assurance/eve-oracle-adapter.js";
import {
  BEHAVIORAL_DEFECT_CLASSES,
  BEHAVIORAL_TAXONOMY,
} from "../src/assurance/behavioral-taxonomy.js";
import { validateSuite } from "../src/assurance/probe.js";
import { behavioralSuite, suiteNames } from "../src/assurance/suites/index.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SubprocessRunner } from "../src/evidence/runner.js";
import { FakeRunner } from "./helpers.js";
import type { RunOptions } from "../src/evidence/runner.js";

// Same technique as the collector fix: EVE writes report.json into whatever
// --out directory it is given rather than printing to stdout, so the fake
// runner honors that flag instead of mocking stdout directly.
class EveFakeRunner extends FakeRunner {
  readonly #goalAchieved: boolean | null;
  readonly #steps: number;
  constructor(goalAchieved: boolean | null, steps = 1) {
    super();
    this.#goalAchieved = goalAchieved;
    this.#steps = steps;
  }
  override run(command: readonly string[], options: RunOptions) {
    const outIndex = command.indexOf("--out");
    const outDir = outIndex >= 0 ? command[outIndex + 1] : undefined;
    if (outDir && this.#goalAchieved !== null) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(
        join(outDir, "report.json"),
        JSON.stringify({ goalAchieved: this.#goalAchieved, usage: { steps: this.#steps } }),
        "utf8",
      );
    }
    return super.run(command, options);
  }
}

const TASK = { prompt: "x", url: "mock:", persona: "first-time-user", goal: "export your notes", seed: 1 };

function probe(overrides: Partial<{ id: string; completion: string; expect: "accept" | "reject" }> = {}) {
  return {
    id: overrides.id ?? "p1",
    defect_class: "incidental_label_match" as const,
    domain: "behavioral" as const,
    task: TASK,
    completion: overrides.completion ?? JSON.stringify(["notes"]),
    expect: overrides.expect ?? ("reject" as const),
    rationale: "test probe",
  };
}

describe("behavioral taxonomy", () => {
  it("is provenance-distinct from Ray's RLVR taxonomy", () => {
    expect(BEHAVIORAL_DEFECT_CLASSES).toEqual(["zero_interaction_success", "incidental_label_match"]);
    for (const id of BEHAVIORAL_DEFECT_CLASSES) {
      expect(BEHAVIORAL_TAXONOMY[id].domain).toBe("behavioral");
    }
  });
});

describe("behavioral suite", () => {
  it("registers under the shared suite registry", () => {
    expect(suiteNames()).toContain("behavioral");
  });

  it("is a valid, diagnostic suite", () => {
    expect(validateSuite(behavioralSuite)).toEqual([]);
  });

  it("is a controlled minimal pair: exploit and control share every step but the last", () => {
    const exploit = behavioralSuite.probes.find((p) => p.id === "behavioral/incidental-label");
    const control = behavioralSuite.probes.find((p) => p.id === "behavioral/control-genuine-completion");
    expect(exploit?.task).toEqual(control?.task);
    expect(exploit?.completion).not.toBe(control?.completion);
  });
});

describe("EveOracleAdapter — mocked", () => {
  const adapter = (runner: FakeRunner) =>
    new EveOracleAdapter({ bin: ["fake-eve"], timeout_ms: 5000 }, runner);

  it("maps goalAchieved: false to a rejected verdict", async () => {
    const response = await adapter(new EveFakeRunner(false)).judge(probe({ expect: "reject" }));
    expect(response.observed).toBe("reject");
  });

  it("maps goalAchieved: true to an accepted verdict", async () => {
    const response = await adapter(new EveFakeRunner(true)).judge(probe({ expect: "accept" }));
    expect(response.observed).toBe("accept");
  });

  it("records steps in the response note for diagnosis", async () => {
    const response = await adapter(new EveFakeRunner(true, 0)).judge(probe());
    expect(response.note).toContain("steps=0");
  });

  it("errors when report.json is never written", async () => {
    const response = await adapter(new EveFakeRunner(null)).judge(probe());
    expect(response.observed).toBe("error");
    expect(response.note).toContain("report.json");
  });

  it("errors when the completion is not a JSON string array", async () => {
    const response = await adapter(new EveFakeRunner(true)).judge(probe({ completion: "not json" }));
    expect(response.observed).toBe("error");
  });

  it("errors when task is missing url/persona/goal", async () => {
    const bad = { ...probe(), task: { prompt: "x" } };
    const response = await adapter(new EveFakeRunner(true)).judge(bad);
    expect(response.observed).toBe("error");
  });

  it("passes --config and --out, never --json (eve has no such flag)", async () => {
    const runner = new EveFakeRunner(true);
    await adapter(runner).judge(probe());
    const call = runner.calls[0];
    expect(call?.command).toEqual(expect.arrayContaining(["--config", "--out"]));
    expect(call?.command).not.toContain("--json");
  });

  it("describes itself for ledger recording", () => {
    const description = adapter(new EveFakeRunner(true)).describe();
    expect(description.bin).toEqual(["fake-eve"]);
  });
});

describe("behavioral audit — mocked end to end", () => {
  it("flags both planted defect classes when the oracle accepts everything", async () => {
    const adapter = new EveOracleAdapter({ bin: ["fake-eve"], timeout_ms: 5000 }, new EveFakeRunner(true));
    const record = await runAudit({ verifier: adapter, suite: behavioralSuite });

    expect(record.conclusion.verdict).toBe("EXPLOITABLE");
    expect([...record.conclusion.metrics.exploitable_classes].sort()).toEqual([
      "incidental_label_match",
      "zero_interaction_success",
    ]);
  });

  it("is sound when the oracle correctly rejects both exploits and accepts the control", async () => {
    // A runner whose decision depends on which probe is being judged — a
    // stand-in for a corrected oracle, since no such EVE build exists yet.
    class DiscriminatingRunner extends FakeRunner {
      override run(command: readonly string[], options: RunOptions) {
        const configIndex = command.indexOf("--config");
        const outIndex = command.indexOf("--out");
        const outDir = outIndex >= 0 ? command[outIndex + 1] : undefined;
        const configFile = configIndex >= 0 ? command[configIndex + 1] : undefined;
        if (outDir && configFile) {
          const config = JSON.parse(readFileSync(configFile, "utf8")) as { goalSuccessSignals?: string[] };
          const genuine = JSON.stringify(config.goalSuccessSignals) === JSON.stringify(["download"]);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(
            join(outDir, "report.json"),
            JSON.stringify({ goalAchieved: genuine, usage: { steps: genuine ? 12 : 0 } }),
            "utf8",
          );
        }
        return super.run(command, options);
      }
    }

    const adapter = new EveOracleAdapter({ bin: ["fake-eve"], timeout_ms: 5000 }, new DiscriminatingRunner());
    const record = await runAudit({ verifier: adapter, suite: behavioralSuite });

    expect(record.conclusion.verdict).toBe("SOUND");
    expect(record.conclusion.findings).toEqual([]);
  });
});

// ── Live, optional: the real eve binary from the sibling checkout ──────────
//
// This is what actually validates EVE-001 rather than a hand-authored mock of
// it. It runs only when a sibling `experience-validation-engine` checkout is
// present (this session's environment; not assumed of CI, which checks out
// this repository alone) — skipped cleanly otherwise, never faked.

const EVE_REPO = "/home/user/experience-validation-engine";
const EVE_BIN_PATH = join(EVE_REPO, "bin", "eve.js");
const eveAvailable = existsSync(EVE_BIN_PATH);

describe.skipIf(!eveAvailable)("behavioral audit — live against the real eve binary", () => {
  it("reproduces EVE-001: both exploits accepted, the control genuinely completed", async () => {
    const adapter = new EveOracleAdapter(
      { bin: ["node", EVE_BIN_PATH], timeout_ms: 60_000, cwd: EVE_REPO },
      new SubprocessRunner(),
    );
    const record = await runAudit({ verifier: adapter, suite: behavioralSuite });

    expect(record.conclusion.verdict).toBe("EXPLOITABLE");
    expect([...record.conclusion.metrics.exploitable_classes].sort()).toEqual([
      "incidental_label_match",
      "zero_interaction_success",
    ]);

    const zeroInteraction = record.results.find((r) => r.probe_id === "behavioral/zero-interaction");
    expect(zeroInteraction?.outcome).toBe("false_accept");

    const control = record.results.find((r) => r.probe_id === "behavioral/control-genuine-completion");
    expect(control?.outcome).toBe("correct");
  }, 120_000);

  it("records the audit in the ledger with a retrievable transcript", async () => {
    const ledger = new Ledger(":memory:");
    const adapter = new EveOracleAdapter(
      { bin: ["node", EVE_BIN_PATH], timeout_ms: 60_000, cwd: EVE_REPO },
      new SubprocessRunner(),
    );
    const record = await runAudit({ verifier: adapter, suite: behavioralSuite, ledger });

    expect(record.ledger_entry).toBeTruthy();
    expect(ledger.verifyChain().ok).toBe(true);
    for (const r of record.results) {
      expect(r.artifact_digest).toBeTruthy();
      expect(ledger.getArtifact(r.artifact_digest ?? "")).toContain("eve stdout");
    }
    ledger.close();
  }, 120_000);
});
