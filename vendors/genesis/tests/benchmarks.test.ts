/**
 * Benchmark registry + run-benchmark + regression flags.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  listBenchmarks, loadBenchmark, resolveBenchmarkDataset, BenchmarkError,
} from "../src/eval/benchmarks.js";
import { runExperiment } from "../src/eval/runner.js";
import { validateSpec } from "../src/eval/spec.js";
import { main } from "../src/cli/main.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("benchmark registry", () => {
  it("lists the three shipped benchmarks with versions and task counts", () => {
    const infos = listBenchmarks(join(process.cwd(), "benchmarks"));
    expect(infos.map((b) => b.name).sort()).toEqual(["arithmetic-v1", "retrieval-v1", "safety-v1", "sentiment-v1"]);
    for (const b of infos) {
      expect(b.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(b.description.length).toBeGreaterThan(0);
      expect(b.task_count).toBeGreaterThanOrEqual(8);
      expect(b.metrics.length).toBeGreaterThan(0);
    }
  });

  it("loads a benchmark and resolves its dataset against the benchmark dir", async () => {
    const { spec, version } = loadBenchmark("sentiment-v1", join(process.cwd(), "benchmarks"));
    expect(version).toBe("1.0.0");
    expect(spec.subject).toBeUndefined(); // supplied at run time
    const resolved = resolveBenchmarkDataset(spec, join(process.cwd(), "benchmarks", "sentiment-v1"));
    const result = await runExperiment({
      ...resolved,
      subject: { inline: "echo" },
    });
    expect(result.arms[0]?.trials).toHaveLength(8);
  });

  it("runs the python classifier against the registry benchmark: SUPPORTED", async () => {
    const { spec } = loadBenchmark("sentiment-v1", join(process.cwd(), "benchmarks"));
    const resolved = resolveBenchmarkDataset(spec, join(process.cwd(), "benchmarks", "sentiment-v1"));
    const result = await runExperiment({
      ...resolved,
      subject: { command: "python ./examples/python-classifier/subject.py {task_file}" },
    });
    expect(result.verdict.verdict).toBe("SUPPORTED");
  }, 120_000);

  it("rejects unknown benchmarks and falls back to the shipped registry", () => {
    expect(() => loadBenchmark("nope", join(process.cwd(), "benchmarks"))).toThrow(BenchmarkError);
    // A missing custom dir falls back to the shipped registry (cwd → package).
    expect(listBenchmarks(join(tmpdir(), "genesis-no-such-registry")).length).toBeGreaterThan(0);
  });

  it("reads meta only from the benchmark block", () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-bm-"));
    try {
      const sub = join(dir, "demo");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, "benchmark.yaml"), "name: demo\nbenchmark:\n  version: 2.1.0\n  description: Demo workload\n" +
        "dataset:\n  inline:\n    - input: a\nsubject:\n  inline: echo\nevaluator:\n  type: exact\n", "utf8");
      const [info] = listBenchmarks(dir);
      expect(info?.version).toBe("2.1.0");
      expect(info?.description).toBe("Demo workload");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("benchmark templates in specs", () => {
  it("parses a subject-less spec only with a benchmark block", () => {
    const withBlock = validateSpec({ name: "t", benchmark: { version: "1.0.0" }, dataset: {}, evaluator: { type: "exact" } });
    expect(withBlock.subject).toBeUndefined();
    expect(() => validateSpec({ name: "t", dataset: {}, evaluator: { type: "exact" } })).toThrow();
  });

  it("runExperiment refuses a subject-less spec instead of inventing one", async () => {
    await expect(runExperiment({
      name: "t",
      dataset: { inline: [{ input: "a" }] },
      evaluator: { type: "exact" },
    })).rejects.toThrow("spec.subject is required");
  });
});

describe("benchmark CLI", () => {
  it("genesis benchmarks lists the registry", async () => {
    const cap = capture();
    const code = await main(["benchmarks"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("sentiment-v1");
    expect(cap.stdout()).toContain("retrieval-v1");
  });

  it("genesis run-benchmark requires --subject", async () => {
    const cap = capture();
    const code = await main(["run-benchmark", "sentiment-v1"]);
    cap.restore();
    expect(code).toBe(3);
    expect(cap.stderr()).toContain("--subject");
  });

  it("genesis run-benchmark rejects unknown benchmarks", async () => {
    const cap = capture();
    const code = await main(["run-benchmark", "nope", "--subject", "x {task_file}"]);
    cap.restore();
    expect(code).toBe(3);
  });

  it("genesis regression accepts explicit threshold flags", async () => {
    const dir = mkdtempSync(join(tmpdir(), "genesis-reg-"));
    try {
      // Reuse the evidence bundles produced by earlier suites is over-coupling;
      // build two minimal bundles instead.
      const { buildManifest, writeEvidenceBundle } = await import("../src/eval/bundle.js");
      for (const [sub, subject] of [["good", "upper"], ["bad", "echo"]] as const) {
        const result = await runExperiment({
          name: "t",
          dataset: { inline: [{ input: "a", reference: "A" }] },
          subject: { inline: subject },
          evaluator: { type: "exact" },
          metrics: ["task_success"],
        });
        const spec = { name: "t", dataset: {}, subject: { inline: subject }, evaluator: { type: "exact" as const } };
        writeEvidenceBundle(join(dir, sub), spec, result, buildManifest(spec, result));
      }
      const cap = capture();
      const code = await main([
        "regression", "--base", join(dir, "good"), "--candidate", join(dir, "good"),
        "--max-quality-drop", "0.02",
      ]);
      cap.restore();
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("REGRESSION: PASS");

      const cap2 = capture();
      const code2 = await main([
        "regression", "--base", join(dir, "good"), "--candidate", join(dir, "bad"),
        "--max-quality-drop", "0.02",
      ]);
      cap2.restore();
      expect(code2).toBe(1);
      expect(cap2.stdout()).toContain("REGRESSION: FAIL");

      const cap3 = capture();
      const code3 = await main([
        "regression", "--base", join(dir, "good"), "--candidate", join(dir, "good"),
        "--max-quality-drop", "bogus",
      ]);
      cap3.restore();
      expect(code3).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
