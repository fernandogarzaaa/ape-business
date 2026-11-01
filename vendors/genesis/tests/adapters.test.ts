/**
 * Adapter protocol tests: the Node/Python helper packages and the contract
 * they implement (subjects, external evaluators, envelopes, failure modes).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatOutput, formatVerdict, loadOutput, loadTask,
} from "../adapters/node/index.js";
import { runExperiment } from "../src/eval/runner.js";
import { loadSpecFile } from "../src/eval/spec.js";

function hasPython(): boolean {
  try {
    const r = spawnSync("python", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

const itPython = hasPython() ? it : it.skip;

// ── Node adapter: pure envelope functions ──

describe("node adapter envelopes", () => {
  it("formats subject outputs (string verbatim, objects as JSON)", () => {
    expect(formatOutput("hi")).toBe("hi");
    expect(JSON.parse(formatOutput({ echo: 1 }))).toEqual({ echo: 1 });
  });

  it("formats verdicts (bool/number/object) and rejects the rest", () => {
    expect(JSON.parse(formatVerdict(true))).toEqual({ passed: true });
    expect(JSON.parse(formatVerdict(0.5))).toEqual({ score: 0.5 });
    expect(JSON.parse(formatVerdict({ passed: false, faithfulness: 0.9 }))).toEqual({
      passed: false, faithfulness: 0.9,
    });
    expect(() => formatVerdict("yes" as unknown as boolean)).toThrow();
    expect(() => formatVerdict({ note: "no decision" })).toThrow();
    expect(() => formatVerdict(Number.NaN)).toThrow();
  });

  it("loads tasks and outputs from files (JSON parsed when possible)", () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-adapter-"));
    try {
      const taskFile = join(dir, "task.json");
      const outFile = join(dir, "out.json");
      writeFileSync(taskFile, JSON.stringify({ id: "t", input: "x" }), "utf8");
      writeFileSync(outFile, '{"echo":"x"}', "utf8");
      expect(loadTask(taskFile)).toMatchObject({ id: "t" });
      expect(loadOutput(outFile).value).toEqual({ echo: "x" });
      writeFileSync(outFile, "plain text", "utf8");
      expect(loadOutput(outFile).value).toBe("plain text");
      expect(() => loadTask(join(dir, "missing.json"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Node adapter: subprocess protocol conformance ──

describe("node adapter over subprocess", () => {
  it("subject emits structured output; evaluator returns a passed envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-adapter-"));
    try {
      const taskFile = join(dir, "task.json");
      writeFileSync(taskFile, JSON.stringify({ id: "t", input: "hello" }), "utf8");
      const subjectOut = execFileSync("node", ["tests/fixtures/adapter-subject.mjs", taskFile], {
        encoding: "utf8",
        cwd: process.cwd(),
      });
      expect(JSON.parse(subjectOut)).toEqual({ echo: "hello" });

      const outFile = join(dir, "out.json");
      writeFileSync(outFile, subjectOut, "utf8");
      const judgeOut = execFileSync(
        "node", ["tests/fixtures/adapter-evaluator.mjs", taskFile, outFile],
        { encoding: "utf8", cwd: process.cwd() },
      );
      expect(JSON.parse(judgeOut)).toEqual({ passed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Python adapter: subprocess protocol conformance ──

describe("python adapter over subprocess", () => {
  itPython("subject emits structured output; evaluator returns a passed envelope", () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-adapter-"));
    try {
      const taskFile = join(dir, "task.json");
      writeFileSync(taskFile, JSON.stringify({ id: "t", input: "hello" }), "utf8");
      const subjectOut = execFileSync("python", ["tests/fixtures/adapter_subject.py", taskFile], {
        encoding: "utf8",
        cwd: process.cwd(),
      });
      expect(JSON.parse(subjectOut)).toEqual({ echo: "hello" });

      const outFile = join(dir, "out.json");
      writeFileSync(outFile, subjectOut, "utf8");
      const judgeOut = execFileSync(
        "python", ["tests/fixtures/adapter_evaluator.py", taskFile, outFile],
        { encoding: "utf8", cwd: process.cwd() },
      );
      expect(JSON.parse(judgeOut)).toEqual({ passed: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  itPython("evaluator errors emit a diagnosable envelope, not a verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-adapter-"));
    try {
      const taskFile = join(dir, "task.json");
      const outFile = join(dir, "out.json");
      writeFileSync(taskFile, JSON.stringify({ id: "t" }), "utf8");
      writeFileSync(outFile, "{}", "utf8");
      const crash = join(dir, "crash.py");
      writeFileSync(
        crash,
        "import os, sys\nsys.path.insert(0, os.path.join('adapters', 'python'))\n" +
        "from genesis_adapter import run_evaluator\n" +
        "run_evaluator(lambda t, o: 1/0)\n",
        "utf8",
      );
      const r = spawnSync("python", [crash, taskFile, outFile], { encoding: "utf8", cwd: process.cwd() });
      expect(r.status).not.toBe(0);
      const envelope = JSON.parse(r.stdout);
      expect(envelope).toHaveProperty("error");
      expect(envelope).not.toHaveProperty("passed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── end to end through runExperiment ──

describe("adapter examples", () => {
  it("python classifier: SUPPORTED with precision/recall/f1", async () => {
    const result = await runExperiment(loadSpecFile("examples/python-classifier/evaluation.yaml"));
    expect(result.verdict.verdict).toBe("SUPPORTED");
    const get = (m: string) => result.arms[0]?.metrics.find((x) => x.metric === m)?.value;
    expect(get("accuracy")).toBeGreaterThanOrEqual(0.8);
    expect(get("f1")).toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  it("node custom judge: SUPPORTED via command evaluator", async () => {
    const result = await runExperiment(loadSpecFile("examples/command-evaluator/evaluation.yaml"));
    expect(result.verdict.verdict).toBe("SUPPORTED");
    expect(result.arms[0]?.metrics.find((x) => x.metric === "task_success")?.value).toBe(1);
  }, 120_000);

  it("a crashing subject yields errors, never a false SUPPORTED", async () => {
    const result = await runExperiment({
      name: "crash",
      dataset: { inline: [{ input: "a", reference: "A" }] },
      subject: { command: "node -e process.exit(3)" },
      evaluator: { type: "exact" },
      metrics: ["task_success"],
    });
    expect(result.arms[0]?.trials[0]?.error).toBeTruthy();
    expect(result.verdict.verdict).not.toBe("SUPPORTED");
  });
});
