/**
 * Genesis MCP server: use the evaluation & assurance platform from any
 * MCP-compatible agent (Claude Code, Codex, opencode, Hermes, ...).
 *
 * stdio transport (`genesis mcp`). Every tool wraps the same pure modules
 * the CLI uses; nothing here executes anything the CLI could not. Long
 * evaluations can exceed client timeouts — prefer small specs or run the
 * CLI directly for large suites.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { assureEvaluator, decideTrust, renderAssurance, renderTrust } from "../eval/assurance.js";
import { listBenchmarks, loadBenchmark, resolveBenchmarkDataset } from "../eval/benchmarks.js";
import { buildManifest, GENESIS_VERSION, readEvidenceBundle, writeEvidenceBundle, writeTrustBundle } from "../eval/bundle.js";
import { checkRegression, compareBundles, renderComparison } from "../eval/compare.js";
import { renderReport } from "../eval/report.js";
import { runExperiment } from "../eval/runner.js";
import { loadSpecFile, validateSpec, type EvalSpec } from "../eval/spec.js";

const outDirSchema = z.string().optional().describe("Output directory for the evidence bundle (default: fresh temp dir)");
const registrySchema = z.string().optional().describe("Custom benchmark registry directory");

function ok(summary: string, data: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      { type: "text" as const, text: `${summary}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`` },
    ],
  };
}

function fail(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text" as const, text: `genesis: ${message}` }], isError: true as const };
}

function freshOutDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `genesis-mcp-${prefix}-`));
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "genesis", version: GENESIS_VERSION });

  server.registerTool(
    "evaluate",
    {
      title: "Evaluate a system",
      description:
        "Run a declarative Genesis evaluation (claim → dataset → subject → evaluator → metrics → verdict). " +
        "Pass a full spec object; subjects run as local commands. Returns the verdict, metrics, and bundle path.",
      inputSchema: {
        spec: z.record(z.string(), z.unknown()).describe("Evaluation spec (same shape as evaluation.yaml)"),
        outDir: outDirSchema,
      },
    },
    async (args) => {
      try {
        const spec = validateSpec(args.spec as unknown, "<mcp>");
        const result = await runExperiment(spec);
        const outDir = args.outDir ?? freshOutDir(spec.name);
        writeEvidenceBundle(outDir, spec, result, buildManifest(spec, result));
        return ok(renderReport(result), {
          outDir,
          verdict: result.verdict,
          arms: result.arms.map((a) => ({ arm: a.arm, metrics: a.metrics })),
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    "audit_evaluator",
    {
      title: "Audit an evaluator",
      description:
        "Assure the evaluator from a spec with dataset-derived exploit/control probes " +
        "(SOUND | EXPLOITABLE | UNRELIABLE | OVER_STRICT). Optional suite bridges to the published RLVR probe suites.",
      inputSchema: {
        spec: z.record(z.string(), z.unknown()).describe("Evaluation spec whose evaluator gets audited"),
        suite: z.enum(["code", "json", "math", "behavioral"]).optional().describe("Published probe suite bridge"),
      },
    },
    async (args) => {
      try {
        const spec = validateSpec(args.spec as unknown, "<mcp>");
        const assurance = await assureEvaluator(spec, { ...(args.suite ? { suite: args.suite } : {}) });
        return ok(renderAssurance(assurance), {
          verdict: assurance.verdict,
          false_accept_rate: assurance.false_accept_rate,
          false_reject_rate: assurance.false_reject_rate,
          findings: assurance.findings,
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    "trust",
    {
      title: "Evaluate and assure (combined trust)",
      description:
        "Run the evaluation AND assure its evaluator, combining both into TRUSTED | UNTRUSTED | INCONCLUSIVE. " +
        "Writes a trust bundle (evaluation/ + assurance.json + trust.json).",
      inputSchema: {
        spec: z.record(z.string(), z.unknown()).describe("Evaluation spec"),
        suite: z.enum(["code", "json", "math", "behavioral"]).optional(),
        outDir: outDirSchema,
      },
    },
    async (args) => {
      try {
        const spec = validateSpec(args.spec as unknown, "<mcp>");
        const result = await runExperiment(spec);
        const assurance = await assureEvaluator(spec, { ...(args.suite ? { suite: args.suite } : {}) });
        const trust = decideTrust(result.verdict.verdict, assurance.verdict);
        const outDir = args.outDir ?? freshOutDir(spec.name);
        writeTrustBundle(outDir, spec, result, buildManifest(spec, result), assurance, trust);
        return ok(renderTrust(spec.name, result.verdict.summary, assurance, trust), { outDir, trust });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    "list_benchmarks",
    {
      title: "List benchmarks",
      description: "List the versioned workloads in the benchmark registry.",
      inputSchema: { registry: registrySchema },
    },
    async (args) => {
      try {
        const infos = listBenchmarks(args.registry);
        return ok(
          infos.map((b) => `${b.name} v${b.version} — ${b.task_count} tasks — ${b.description}`).join("\n"),
          { benchmarks: infos },
        );
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    "run_benchmark",
    {
      title: "Run a benchmark",
      description:
        "Run your system (command template with {task_file}, or a built-in inline subject) " +
        "against a versioned registry benchmark.",
      inputSchema: {
        benchmark: z.string().describe("Registry name, e.g. sentiment-v1"),
        subjectCommand: z.string().optional().describe("Subject command; exactly one of subjectCommand/subjectInline is required"),
        subjectInline: z.string().optional().describe("Built-in subject: echo|upper|lower|reverse|double|prefix-ok"),
        baselineCommand: z.string().optional().describe("Optional baseline command for paired comparison"),
        outDir: outDirSchema,
        registry: registrySchema,
      },
    },
    async (args) => {
      try {
        if (!args.subjectCommand && !args.subjectInline) {
          return fail("one of subjectCommand / subjectInline is required");
        }
        if (args.subjectCommand && args.subjectInline) {
          return fail("only one of subjectCommand / subjectInline may be given");
        }
        const loaded = loadBenchmark(args.benchmark, args.registry);
        const spec: EvalSpec = {
          ...resolveBenchmarkDataset(loaded.spec, loaded.dir),
          name: `${args.benchmark}@${loaded.version}`,
          subject: args.subjectCommand
            ? { name: "candidate", command: args.subjectCommand }
            : { name: "candidate", inline: args.subjectInline as string },
          ...(args.baselineCommand ? { baseline: { name: "baseline", command: args.baselineCommand } } : {}),
        };
        const result = await runExperiment(spec);
        const outDir = args.outDir ?? freshOutDir(args.benchmark);
        writeEvidenceBundle(outDir, spec, result, buildManifest(spec, result));
        return ok(renderReport(result), {
          outDir,
          benchmark: args.benchmark,
          version: loaded.version,
          verdict: result.verdict,
        });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    "compare_runs",
    {
      title: "Compare two runs",
      description: "Metric deltas between two evidence-bundle directories (run A vs run B).",
      inputSchema: {
        runA: z.string().describe("First bundle directory"),
        runB: z.string().describe("Second bundle directory"),
      },
    },
    async (args) => {
      try {
        const text = renderComparison(args.runA, args.runB);
        return ok(text, compareBundles(args.runA, args.runB));
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    "check_regression",
    {
      title: "Regression gate",
      description:
        "Gate a candidate bundle against a baseline (quality max drop, latency/cost max increase). " +
        "Use in CI: fail the build when this returns pass=false.",
      inputSchema: {
        base: z.string().describe("Baseline bundle directory"),
        candidate: z.string().describe("Candidate bundle directory"),
        maxQualityDrop: z.number().min(0).optional().describe("Default 0.02"),
        maxLatencyIncrease: z.number().min(0).optional().describe("Fraction, e.g. 0.15"),
        maxCostIncrease: z.number().min(0).optional().describe("Fraction"),
      },
    },
    async (args) => {
      try {
        const result = checkRegression(args.base, args.candidate, {
          quality: { max_drop: args.maxQualityDrop ?? 0.02 },
          ...(args.maxLatencyIncrease !== undefined ? { p95_latency: { max_increase: args.maxLatencyIncrease } } : {}),
          ...(args.maxCostIncrease !== undefined ? { cost: { max_increase: args.maxCostIncrease } } : {}),
        });
        const text = result.checks.map((c) => `${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n") +
          `\nREGRESSION: ${result.pass ? "PASS" : "FAIL"}`;
        return ok(text, result);
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    "gate",
    {
      title: "Release gate (capability checkpoint)",
      description:
        "Run the evaluation, assure its evaluator, and bind both to forbidden capability ceilings " +
        "for a fail-closed RELEASE | BLOCK | INCONCLUSIVE decision. Writes a trust bundle with gate.json.",
      inputSchema: {
        spec: z.record(z.string(), z.unknown()).describe("Evaluation spec (may declare gate.forbidden ceilings)"),
        forbidden: z.record(z.string(), z.number()).optional().describe("Metric ceilings that must not be reached (overrides spec)"),
        suite: z.enum(["code", "json", "math", "behavioral"]).optional(),
        outDir: outDirSchema,
      },
    },
    async (args) => {
      try {
        const spec = validateSpec(args.spec as unknown, "<mcp>");
        const result = await runExperiment(spec);
        const assurance = await assureEvaluator(spec, { ...(args.suite ? { suite: args.suite } : {}) });
        const trust = decideTrust(result.verdict.verdict, assurance.verdict);
        const { decideGate, renderGate } = await import("../eval/gate.js");
        const ceilings = args.forbidden ?? spec.gate?.forbidden ?? {};
        const gate = decideGate(result, assurance, trust.trust, ceilings);
        const outDir = args.outDir ?? freshOutDir(spec.name);
        writeTrustBundle(outDir, spec, result, buildManifest(spec, result), assurance, trust, gate);
        return ok(renderGate(spec.name, ceilings, gate), { outDir, gate });
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    "read_report",    {
      title: "Read a report",
      description: "Render the human-readable summary of an evidence-bundle directory.",
      inputSchema: { dir: z.string().describe("Bundle directory") },
    },
    async (args) => {
      try {
        const bundle = readEvidenceBundle(args.dir);
        return ok(`Verdict bundle at ${args.dir}`, bundle);
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  server.registerTool(
    "show_claim",
    {
      title: "Show claim",
      description: "Show the claim and hypotheses in a spec file (claim-first review before running).",
      inputSchema: { specPath: z.string().describe("Path to evaluation.yaml/benchmark.yaml") },
    },
    async (args) => {
      try {
        const spec = loadSpecFile(args.specPath);
        if (!spec.claim) return ok("No claim in this spec.", { claim: null });
        return ok(
          `claim ${spec.claim.id}: ${spec.claim.statement}`,
          { claim: spec.claim },
        );
      } catch (error) {
        return fail((error as Error).message);
      }
    },
  );

  return server;
}

/** stdio entrypoint for `genesis mcp`. Never writes to stdout except protocol. */
export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
