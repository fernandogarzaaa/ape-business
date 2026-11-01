/**
 * Genesis CLI.
 *
 * Exit codes are distinct on purpose: a CI integration must be able to block on
 * EXPLOITABLE without parsing stdout, and Genesis failing (3) must never be
 * confusable with a verifier failing.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AuditError, AUDIT_EXIT, exitCodeFor as auditExitCode, runAudit } from "../assurance/audit.js";
import { EveOracleAdapter } from "../assurance/eve-oracle-adapter.js";
import { renderAudit } from "../assurance/report.js";
import { getSuite, suiteNames } from "../assurance/suites/index.js";
import { ALL_DESCRIPTORS } from "../assurance/findings.js";
import { VerifierAdapter, type AcceptRule, type Judge } from "../assurance/verifier.js";
import type { EvalSpec } from "../eval/spec.js";
import { SubprocessRunner } from "../evidence/runner.js";
import { Ledger } from "../ledger/ledger.js";

const VERSION = "0.2.0";

const USAGE = `genesis ${VERSION} — universal evaluation & assurance for AI-native software

  Evaluation ("does it work?"):
    genesis evaluate <spec.yaml|spec.json> [--out <dir>] [--ledger <db>] [--json]
    genesis run <spec.yaml|spec.json> [--out <dir>] [--ledger <db>] [--json]   (alias)
    genesis report <results-dir>                                               (render report)
    genesis compare <run-a> <run-b>                                            (metric deltas)
    genesis regression --base <run-a> --candidate <run-b> [--config spec.yaml] (gates)
    genesis claims <spec.yaml>                                                 (show claim + hypotheses)

  Trust ("should I believe the verdict?"):
    genesis audit-evaluator <spec.yaml> [--suite <code|json|math|behavioral>] [--ledger <db>] [--json]
    genesis trust <spec.yaml> [--suite <...>] [--out <dir>] [--ledger <db>] [--json]
      exit 0 = TRUSTED · 1 = UNTRUSTED · 2 = INCONCLUSIVE · 3 = internal error

  Benchmarks ("how do we compare over time?"):
    genesis benchmarks [--registry <dir>]                      (list versioned workloads)
    genesis run-benchmark <name> --subject "<cmd>" [--baseline "<cmd>"]
      [--out <dir>] [--ledger <db>] [--json] [--registry <dir>]

  Agent platforms (MCP stdio server for Claude Code, Codex, opencode, ...):
    genesis mcp                                                (serve tools over stdio; see plugins/)

  Frontier validation (capability checkpoints + third-party attestation):
    genesis gate <spec.yaml> [--suite <...>] [--out <dir>] [--ledger <db>] [--json]
      exit 0 = RELEASE · 1 = BLOCK · 2 = INCONCLUSIVE · 3 = internal error
    genesis attest <bundle-dir> --signer <name> --key <private.pem>
    genesis verify <bundle-dir> [--pubkey <a.pem,b.pem>]
    genesis keygen --out <prefix>                              (Ed25519 keypair)

  Assurance ("can I trust the evaluator?"):
    genesis audit              --suite <code|json|math|behavioral> [--ledger <db>] [--json] [--verbose]
                               and exactly one of:
                                 --verifier "<cmd with {task_file} {completion_file}>"  (code/json/math)
                                 --oracle eve [--eve-bin "<cmd>"]                       (behavioral)
                               [--name <label>] [--accept exit_zero|json_reward|json_pass]
                               [--threshold <n>] [--timeout <ms>]
                               exit 0 = SOUND · 1 = EXPLOITABLE · 2 = UNRELIABLE/OVER_STRICT · 3 = internal error

    genesis suites             list probe suites and the defect classes they cover
`;

export async function main(argv: readonly string[]): Promise<number> {
  const [command] = argv;

  try {
    switch (command) {
      case undefined:
      case "-h":
      case "--help":
      case "help":
        process.stdout.write(USAGE);
        return 0;

      case "-v":
      case "--version":
        process.stdout.write(`genesis ${VERSION}\n`);
        return 0;

      case "audit":
        return await cmdAudit(argv.slice(1));

      case "evaluate":
      case "run":
        return await cmdEvaluate(argv.slice(1));

      case "report":
        return cmdReport(argv.slice(1));

      case "compare":
        return await cmdCompare(argv.slice(1));

      case "regression":
        return await cmdRegression(argv.slice(1));

      case "claims":
        return await cmdClaims(argv.slice(1));

      case "audit-evaluator":
        return await cmdAuditEvaluator(argv.slice(1));

      case "trust":
        return await cmdTrust(argv.slice(1));

      case "benchmarks":
        return await cmdBenchmarks(argv.slice(1));

      case "run-benchmark":
        return await cmdRunBenchmark(argv.slice(1));

      case "mcp":
        return await cmdMcp();

      case "gate":
        return await cmdGate(argv.slice(1));

      case "attest":
        return await cmdAttest(argv.slice(1));

      case "verify":
        return await cmdVerify(argv.slice(1));

      case "keygen":
        return await cmdKeygen(argv.slice(1));

      case "suites":
        return cmdSuites();

      default:
        fail(`unknown command "${command}"`);
        process.stderr.write(USAGE);
        return AUDIT_EXIT.INTERNAL_ERROR;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

// ── audit ───────────────────────────────────────────────────────────────────

async function cmdAudit(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      verifier: { type: "string" },
      oracle: { type: "string" },
      "eve-bin": { type: "string", default: "npx eve" },
      suite: { type: "string" },
      name: { type: "string" },
      accept: { type: "string", default: "json_reward" },
      threshold: { type: "string" },
      field: { type: "string" },
      timeout: { type: "string", default: "30000" },
      ledger: { type: "string" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (!values.suite) return usageError(`--suite is required, one of: ${suiteNames().join(", ")}`);
  const suite = getSuite(values.suite);
  if (!suite) return usageError(`unknown suite "${values.suite}", expected one of: ${suiteNames().join(", ")}`);

  if (!!values.verifier === (values.oracle !== undefined)) {
    return usageError(
      'pass exactly one of --verifier "<cmd with {task_file} {completion_file}>" (RLVR-style suites: ' +
        "code/json/math) or --oracle eve (behavioral-style suites: behavioral)",
    );
  }

  let judge: Judge;

  if (values.oracle !== undefined) {
    if (values.oracle !== "eve") {
      return usageError(`unknown --oracle "${values.oracle}"; the only behavioral judge available is "eve"`);
    }
    judge = new EveOracleAdapter(
      { bin: values["eve-bin"].trim().split(/\s+/), timeout_ms: Number(values.timeout ?? 30000) },
      new SubprocessRunner(),
    );
  } else {
    const command = (values.verifier as string).trim().split(/\s+/);
    if (!command.some((p) => p.includes("{task_file}")) || !command.some((p) => p.includes("{completion_file}"))) {
      return usageError("--verifier must contain both {task_file} and {completion_file} placeholders");
    }

    const accept = buildAcceptRule(values.accept, values.field, values.threshold);
    if (accept === null) {
      return usageError('--accept must be one of: exit_zero, json_reward, json_pass');
    }

    judge = new VerifierAdapter(
      {
        name: values.name ?? command[0] ?? "verifier",
        command,
        accept,
        timeout_ms: Number(values.timeout ?? 30000),
      },
      new SubprocessRunner(),
    );
  }

  // The ledger is optional here. An audit is useful as a one-shot check; it
  // becomes evidence only when someone needs to prove it happened.
  const ledger = values.ledger ? new Ledger(values.ledger) : undefined;

  try {
    const record = await runAudit({
      verifier: judge,
      suite,
      ledger,
      events:
        values.json || values.verbose
          ? {}
          : {
              onProbeStart: (probe, i, total) =>
                process.stderr.write(`  [${i}/${total}] ${probe.id}…\n`),
            },
    });

    if (values.json) {
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      process.stdout.write(renderAudit(record, { verbose: values.verbose }));
    }

    return auditExitCode(record.conclusion.verdict);
  } catch (error) {
    if (error instanceof AuditError) {
      fail(error.message);
      return AUDIT_EXIT.INTERNAL_ERROR;
    }
    throw error;
  } finally {
    ledger?.close();
  }
}

function buildAcceptRule(
  kind: string | undefined,
  field: string | undefined,
  threshold: string | undefined,
): AcceptRule | null {
  switch (kind) {
    case "exit_zero":
      return { kind: "exit_zero" };
    case "json_pass":
      return { kind: "json_pass", ...(field ? { field } : {}) };
    case "json_reward":
    case undefined:
      return {
        kind: "json_reward",
        ...(field ? { field } : {}),
        ...(threshold ? { threshold: Number(threshold) } : {}),
      };
    default:
      return null;
  }
}

function cmdSuites(): number {
  for (const name of suiteNames()) {
    const suite = getSuite(name);
    if (!suite) continue;
    const exploits = suite.probes.filter((p) => p.expect === "reject");
    const controls = suite.probes.filter((p) => p.expect === "accept");
    const classes = [...new Set(exploits.map((p) => p.defect_class))].sort();

    process.stdout.write(
      `${name}@${suite.version}  ${exploits.length} exploit + ${controls.length} control probes\n`,
    );
    for (const id of classes) {
      process.stdout.write(`    ${id.padEnd(26)} ${ALL_DESCRIPTORS[id].defect}\n`);
    }
    process.stdout.write("\n");
  }
  return 0;
}

// ── universal evaluation ────────────────────────────────────────────────────

async function cmdEvaluate(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      out: { type: "string" },
      ledger: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const specPath = positionals[0];
  if (!specPath) return usageError("usage: genesis evaluate <spec.yaml|spec.json> [--out <dir>] [--ledger <db>] [--json]");

  const { loadSpecFile } = await import("../eval/spec.js");
  const { runExperiment } = await import("../eval/runner.js");
  const { buildManifest, writeEvidenceBundle } = await import("../eval/bundle.js");
  const { renderReport } = await import("../eval/report.js");
  const { hashCanonical } = await import("../shared/canonical.js");

  let spec: EvalSpec | undefined;
  try {
    spec = loadSpecFile(specPath);
  } catch (error) {
    return usageError((error as Error).message);
  }
  if (!spec.dataset.path && !spec.dataset.inline && !spec.dataset.stdin) {
    return usageError("spec.dataset: one of path, inline, or stdin is required");
  }
  if (!spec.subject) {
    return usageError("spec.subject is required to run (benchmark templates declare it via --subject; see genesis run-benchmark)");
  }

  try {
    const result = await runExperiment(spec);
    const outDir = values.out ?? `${spec.name}-results`;
    const manifest = buildManifest(spec, result);
    writeEvidenceBundle(outDir, spec, result, manifest);

    // Ledger is optional; an evaluation is useful as a one-shot check and
    // becomes evidence when recorded.
    if (values.ledger) {
      const { Ledger } = await import("../ledger/ledger.js");
      const ledger = new Ledger(values.ledger);
      try {
        ledger.recordEvaluation(
          hashCanonical({ spec_digest: result.spec_digest, dataset_digest: result.dataset.digest }),
          {
            spec_digest: result.spec_digest,
            dataset_digest: result.dataset.digest,
            verdict: result.verdict,
            metrics: result.arms.map((a) => ({ arm: a.arm, metrics: a.metrics })),
            out_dir: outDir,
          },
        );
      } finally {
        ledger.close();
      }
    }

    if (values.json) {
      process.stdout.write(`${JSON.stringify({ out_dir: outDir, verdict: result.verdict, arms: result.arms.map((a) => ({ arm: a.arm, metrics: a.metrics })) }, null, 2)}\n`);
    } else {
      process.stdout.write(renderReport(result));
      process.stdout.write(`Evidence bundle: ${outDir}/\n`);
    }
    return result.verdict.verdict === "SUPPORTED" ? 0 : result.verdict.verdict === "FALSIFIED" ? 1 : 2;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

function cmdReport(argv: readonly string[]): number {
  const [dir] = argv;
  if (!dir) {
    fail("usage: genesis report <results-dir>");
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
  try {
    const verdict = JSON.parse(readFileSync(join(dir, "verdict.json"), "utf8")) as {
      verdict: string;
      summary: string;
      scope: Record<string, unknown>;
      hypothesis_results?: readonly { metric: string; operator: string; threshold: number; observed: number | null; satisfied: boolean | null }[];
    };
    const lines = ["", `VERDICT: ${verdict.verdict}`, verdict.summary, ""];
    lines.push(`dataset: ${JSON.stringify((verdict.scope as Record<string, unknown>).dataset)}`);
    for (const arm of ["treatment", "baseline"]) {
      try {
        const metrics = JSON.parse(readFileSync(join(dir, arm, "metrics.json"), "utf8")) as { metric: string; value: number; n: number }[];
        lines.push(`${arm}: ${metrics.map((m) => `${m.metric}=${Math.round(m.value * 10000) / 10000} (n=${m.n})`).join(", ")}`);
      } catch {
        // arm absent — fine
      }
    }
    if (verdict.hypothesis_results) {
      for (const h of verdict.hypothesis_results) {
        lines.push(`  ${h.satisfied === true ? "✓" : h.satisfied === false ? "✗" : "?"} ${h.metric} ${h.operator} ${h.threshold} (observed ${h.observed ?? "n/a"})`);
      }
    }
    try {
      const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as { severity: string; category: string; summary: string }[];
      lines.push(`findings: ${findings.length}`);
      for (const f of findings.slice(0, 10)) lines.push(`  [${f.severity}] ${f.category} — ${f.summary.slice(0, 200)}`);
    } catch {
      // no findings — fine
    }
    lines.push("");
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    fail(`cannot read bundle at ${dir}: ${(error as Error).message}`);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

async function cmdCompare(argv: readonly string[]): Promise<number> {
  const [a, b] = argv;
  if (!a || !b) {
    fail("usage: genesis compare <run-a> <run-b>");
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
  try {
    const { renderComparison } = await import("../eval/compare.js");
    process.stdout.write(renderComparison(a, b));
    return 0;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

async function cmdRegression(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      base: { type: "string" },
      candidate: { type: "string" },
      config: { type: "string" },
      "max-quality-drop": { type: "string" },
      "max-latency-increase": { type: "string" },
      "max-cost-increase": { type: "string" },
    },
    allowPositionals: false,
  });
  if (!values.base || !values.candidate) {
    return usageError("usage: genesis regression --base <run-a> --candidate <run-b> [--config spec.yaml] [--max-quality-drop <f>] [--max-latency-increase <f>] [--max-cost-increase <f>]");
  }
  let regression: EvalSpec["regression"] | undefined;
  if (values.config) {
    const { loadSpecFile } = await import("../eval/spec.js");
    try {
      regression = loadSpecFile(values.config).regression;
    } catch (error) {
      return usageError((error as Error).message);
    }
  }
  const num = (v: string | undefined, name: string): number | undefined => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number, got "${v}"`);
    return n;
  };
  let maxQualityDrop: number | undefined;
  let maxLatencyIncrease: number | undefined;
  let maxCostIncrease: number | undefined;
  try {
    maxQualityDrop = num(values["max-quality-drop"], "max-quality-drop");
    maxLatencyIncrease = num(values["max-latency-increase"], "max-latency-increase");
    maxCostIncrease = num(values["max-cost-increase"], "max-cost-increase");
  } catch (error) {
    return usageError((error as Error).message);
  }
  const { checkRegression } = await import("../eval/compare.js");
  const result = checkRegression(values.base, values.candidate, {
    quality: { max_drop: maxQualityDrop ?? regression?.quality?.max_drop ?? 0.02 },
    p95_latency: (maxLatencyIncrease ?? regression?.p95_latency?.max_increase) !== undefined
      ? { max_increase: (maxLatencyIncrease ?? regression?.p95_latency?.max_increase) as number }
      : undefined,
    cost: (maxCostIncrease ?? regression?.cost?.max_increase) !== undefined
      ? { max_increase: (maxCostIncrease ?? regression?.cost?.max_increase) as number }
      : undefined,
  });
  for (const c of result.checks) {
    process.stdout.write(`  ${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}\n`);
  }
  process.stdout.write(result.pass ? "REGRESSION: PASS\n" : "REGRESSION: FAIL\n");
  return result.pass ? 0 : 1;
}

async function cmdClaims(argv: readonly string[]): Promise<number> {
  const [specPath] = argv;
  if (!specPath) {
    fail("usage: genesis claims <spec.yaml>");
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
  const { loadSpecFile } = await import("../eval/spec.js");
  let spec: EvalSpec | undefined;
  try {
    spec = loadSpecFile(specPath);
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
  if (!spec.claim) {
    process.stdout.write("no claim in this spec (claim-first evaluation needs spec.claim)\n");
    return 0;
  }
  process.stdout.write(`claim ${spec.claim.id}: ${spec.claim.statement}\n`);
  if (spec.claim.hypothesis) {
    const h = spec.claim.hypothesis.primary;
    process.stdout.write(`  primary: ${h.metric} ${h.operator} ${h.threshold}\n`);
    for (const s of spec.claim.hypothesis.secondary ?? []) {
      process.stdout.write(`  secondary: ${s.metric} ${s.operator} ${s.threshold}\n`);
    }
  }
  return 0;
}

// ── evaluator assurance + combined trust ────────────────────────────────────

async function cmdAuditEvaluator(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      suite: { type: "string" },
      ledger: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const specPath = positionals[0];
  if (!specPath) {
    return usageError("usage: genesis audit-evaluator <spec.yaml> [--suite <code|json|math|behavioral>] [--ledger <db>] [--json]");
  }
  const { loadSpecFile } = await import("../eval/spec.js");
  const { assureEvaluator, renderAssurance } = await import("../eval/assurance.js");
  const { hashCanonical } = await import("../shared/canonical.js");
  let spec: EvalSpec | undefined;
  try {
    spec = loadSpecFile(specPath);
  } catch (error) {
    return usageError((error as Error).message);
  }
  try {
    const assurance = await assureEvaluator(spec, { ...(values.suite ? { suite: values.suite } : {}) });
    if (values.ledger) {
      const { Ledger } = await import("../ledger/ledger.js");
      const ledger = new Ledger(values.ledger);
      try {
        ledger.recordEvaluation(
          hashCanonical({ kind: "evaluator-assurance", spec_digest: specPath, dataset_digest: assurance.dataset_digest }),
          { kind: "evaluator-assurance", spec: specPath, assurance },
        );
      } finally {
        ledger.close();
      }
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify(assurance, null, 2)}\n`);
    } else {
      process.stdout.write(renderAssurance(assurance));
    }
    return assurance.verdict === "SOUND" ? 0 : assurance.verdict === "EXPLOITABLE" ? 1 : 2;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

async function cmdTrust(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      suite: { type: "string" },
      out: { type: "string" },
      ledger: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const specPath = positionals[0];
  if (!specPath) {
    return usageError("usage: genesis trust <spec.yaml> [--suite <...>] [--out <dir>] [--ledger <db>] [--json]");
  }
  const { loadSpecFile } = await import("../eval/spec.js");
  const { runExperiment } = await import("../eval/runner.js");
  const { buildManifest, writeTrustBundle } = await import("../eval/bundle.js");
  const { assureEvaluator, decideTrust, renderTrust } = await import("../eval/assurance.js");
  const { hashCanonical } = await import("../shared/canonical.js");
  let spec: EvalSpec | undefined;
  try {
    spec = loadSpecFile(specPath);
  } catch (error) {
    return usageError((error as Error).message);
  }
  try {
    const result = await runExperiment(spec);
    const assurance = await assureEvaluator(spec, { ...(values.suite ? { suite: values.suite } : {}) });
    const trust = decideTrust(result.verdict.verdict, assurance.verdict);
    const outDir = values.out ?? `${spec.name}-trust`;
    writeTrustBundle(outDir, spec, result, buildManifest(spec, result), assurance, trust);
    if (values.ledger) {
      const { Ledger } = await import("../ledger/ledger.js");
      const ledger = new Ledger(values.ledger);
      try {
        ledger.recordEvaluation(
          hashCanonical({ kind: "trust", spec_digest: result.spec_digest, dataset_digest: result.dataset.digest }),
          { kind: "trust", spec_digest: result.spec_digest, verdict: result.verdict, assurance, trust, out_dir: outDir },
        );
      } finally {
        ledger.close();
      }
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ out_dir: outDir, trust, system: result.verdict, evaluator: assurance.verdict }, null, 2)}\n`);
    } else {
      process.stdout.write(renderTrust(spec.name, result.verdict.summary, assurance, trust));
      process.stdout.write(`Trust bundle: ${outDir}/\n`);
    }
    return trust.trust === "TRUSTED" ? 0 : trust.trust === "UNTRUSTED" ? 1 : 2;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

// ── benchmark registry ──────────────────────────────────────────────────────

async function cmdBenchmarks(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { registry: { type: "string" } },
    allowPositionals: false,
  });
  try {
    const { listBenchmarks, resolveRegistry } = await import("../eval/benchmarks.js");
    const infos = listBenchmarks(values.registry);
    process.stdout.write(`Benchmark registry: ${resolveRegistry(values.registry)}\n\n`);
    if (infos.length === 0) process.stdout.write("(no benchmarks found)\n");
    for (const b of infos) {
      process.stdout.write(
        `${b.name}  v${b.version}  ${b.task_count >= 0 ? `${b.task_count} tasks` : "unreadable dataset"}\n` +
        `    ${b.description}\n` +
        `    metrics: ${b.metrics.join(", ") || "(none)"}\n\n`,
      );
    }
    return 0;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

async function cmdRunBenchmark(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      subject: { type: "string" },
      baseline: { type: "string" },
      out: { type: "string" },
      ledger: { type: "string" },
      json: { type: "boolean", default: false },
      registry: { type: "string" },
    },
    allowPositionals: true,
  });
  const [name] = positionals;
  if (!name) return usageError("usage: genesis run-benchmark <name> --subject \"<cmd>\" [--baseline \"<cmd>\"] [--out <dir>] [--json] [--registry <dir>]");
  if (!values.subject) return usageError("run-benchmark requires --subject \"<command with {task_file}>\" (the system under test)");

  const { loadBenchmark, resolveBenchmarkDataset } = await import("../eval/benchmarks.js");
  const { runExperiment } = await import("../eval/runner.js");
  const { buildManifest, writeEvidenceBundle } = await import("../eval/bundle.js");
  const { renderReport } = await import("../eval/report.js");
  const { hashCanonical } = await import("../shared/canonical.js");
  const { Ledger } = values.ledger ? await import("../ledger/ledger.js") : { Ledger: null as never };

  try {
    const loaded = loadBenchmark(name, values.registry);
    const base = resolveBenchmarkDataset(loaded.spec, loaded.dir);
    const spec = {
      ...base,
      name: `${name}@${loaded.version}`,
      subject: { name: "candidate", command: values.subject },
      ...(values.baseline ? { baseline: { name: "baseline", command: values.baseline } } : {}),
    };
    const result = await runExperiment(spec);
    const outDir = values.out ?? `${name}-results`;
    writeEvidenceBundle(outDir, spec, result, buildManifest(spec, result));
    if (values.ledger && Ledger) {
      const ledger = new Ledger(values.ledger);
      try {
        ledger.recordBenchmark(
          hashCanonical({ benchmark: name, version: loaded.version, dataset_digest: result.dataset.digest }),
          { benchmark: name, version: loaded.version, verdict: result.verdict, out_dir: outDir },
        );
      } finally {
        ledger.close();
      }
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ out_dir: outDir, benchmark: name, version: loaded.version, verdict: result.verdict }, null, 2)}\n`);
    } else {
      process.stdout.write(renderReport(result));
      process.stdout.write(`Evidence bundle: ${outDir}/\n`);
    }
    return result.verdict.verdict === "SUPPORTED" ? 0 : result.verdict.verdict === "FALSIFIED" ? 1 : 2;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function cmdMcp(): Promise<number> {
  // stdio is the protocol channel: keep it clean, diagnostics go to stderr.
  try {
    const { runMcpServer } = await import("../mcp/server.js");
    await runMcpServer();
    return 0;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

// ── capability gate + attestation ───────────────────────────────────────────

async function cmdGate(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      suite: { type: "string" },
      out: { type: "string" },
      ledger: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const specPath = positionals[0];
  if (!specPath) {
    return usageError("usage: genesis gate <spec.yaml> [--suite <...>] [--out <dir>] [--ledger <db>] [--json]");
  }
  const { loadSpecFile } = await import("../eval/spec.js");
  const { runExperiment } = await import("../eval/runner.js");
  const { buildManifest, writeTrustBundle } = await import("../eval/bundle.js");
  const { assureEvaluator, decideTrust } = await import("../eval/assurance.js");
  const { decideGate, renderGate } = await import("../eval/gate.js");
  const { hashCanonical } = await import("../shared/canonical.js");
  let spec: EvalSpec | undefined;
  try {
    spec = loadSpecFile(specPath);
  } catch (error) {
    return usageError((error as Error).message);
  }
  try {
    const result = await runExperiment(spec);
    const assurance = await assureEvaluator(spec, { ...(values.suite ? { suite: values.suite } : {}) });
    const trust = decideTrust(result.verdict.verdict, assurance.verdict);
    const gate = decideGate(result, assurance, trust.trust, spec.gate?.forbidden ?? {});
    const outDir = values.out ?? `${spec.name}-gate`;
    writeTrustBundle(outDir, spec, result, buildManifest(spec, result), assurance, trust, gate);
    if (values.ledger) {
      const { Ledger } = await import("../ledger/ledger.js");
      const ledger = new Ledger(values.ledger);
      try {
        ledger.recordEvaluation(
          hashCanonical({ kind: "gate", spec_digest: result.spec_digest, dataset_digest: result.dataset.digest }),
          { kind: "gate", spec_digest: result.spec_digest, gate, out_dir: outDir },
        );
      } finally {
        ledger.close();
      }
    }
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ out_dir: outDir, gate }, null, 2)}\n`);
    } else {
      process.stdout.write(renderGate(spec.name, spec.gate?.forbidden ?? {}, gate));
      process.stdout.write(`Gate bundle: ${outDir}/\n`);
    }
    return gate.decision === "RELEASE" ? 0 : gate.decision === "BLOCK" ? 1 : 2;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

async function cmdAttest(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      signer: { type: "string" },
      key: { type: "string" },
    },
    allowPositionals: true,
  });
  const [dir] = positionals;
  if (!dir || !values.signer || !values.key) {
    return usageError("usage: genesis attest <bundle-dir> --signer <name> --key <private.pem>");
  }
  try {
    const { readFileSync } = await import("node:fs");
    const { attestBundle } = await import("../eval/attest.js");
    const attestation = attestBundle(dir, values.signer, readFileSync(values.key, "utf8"));
    process.stdout.write(`Attested by ${attestation.signer} at ${attestation.timestamp}\n`);
    process.stdout.write(`  bundle: ${attestation.bundle_digest}\n`);
    process.stdout.write(`  key: ${attestation.key_fingerprint}\n`);
    return 0;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

async function cmdVerify(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { pubkey: { type: "string", multiple: true } },
    allowPositionals: true,
  });
  const [dir] = positionals;
  if (!dir) return usageError("usage: genesis verify <bundle-dir> [--pubkey <a.pem,b.pem>]");
  try {
    const { readFileSync } = await import("node:fs");
    const { verifyBundle } = await import("../eval/attest.js");
    const keys: string[] = [];
    for (const entry of values.pubkey ?? []) {
      for (const path of entry.split(",").map((s) => s.trim()).filter(Boolean)) {
        keys.push(readFileSync(path, "utf8"));
      }
    }
    const verification = verifyBundle(dir, keys);
    process.stdout.write(`bundle: ${verification.bundle_digest}\n`);
    if (verification.checks.length === 0) {
      process.stdout.write("no attestations found — nothing to verify\n");
    }
    for (const c of verification.checks) {
      const mark = c.digest_match && c.signature_valid !== false ? "✓" : "✗";
      process.stdout.write(`  ${mark} ${c.signer}: ${c.detail}\n`);
    }
    process.stdout.write(verification.ok ? "VERIFIED\n" : "VERIFICATION FAILED\n");
    return verification.ok ? 0 : 1;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

async function cmdKeygen(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { out: { type: "string" } },
    allowPositionals: false,
  });
  if (!values.out) return usageError("usage: genesis keygen --out <prefix>");
  try {
    const { writeFileSync, chmodSync } = await import("node:fs");
    const { generateKeypair, fingerprint } = await import("../eval/attest.js");
    const { privateKey, publicKey } = generateKeypair();
    const privPath = `${values.out}.ed25519.pem`;
    const pubPath = `${values.out}.ed25519.pub.pem`;
    writeFileSync(privPath, privateKey, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(privPath, 0o600);
    } catch {
      // Best effort (Windows ignores POSIX modes).
    }
    writeFileSync(pubPath, publicKey, "utf8");
    process.stdout.write(`private: ${privPath} (keep secret)\npublic:  ${pubPath}\n`);
    process.stdout.write(`fingerprint: ${fingerprint(publicKey)}\n`);
    return 0;
  } catch (error) {
    fail((error as Error).message);
    return AUDIT_EXIT.INTERNAL_ERROR;
  }
}

function usageError(message: string): number {
  fail(message);
  return AUDIT_EXIT.INTERNAL_ERROR;
}

function fail(message: string): void {
  process.stderr.write(`genesis: ${message}\n`);
}
