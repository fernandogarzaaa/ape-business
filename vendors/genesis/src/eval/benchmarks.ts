/**
 * Benchmark registry: versioned, reusable evaluation workloads.
 *
 * A benchmark is a directory holding a `benchmark.yaml` (an EvalSpec without
 * a subject — the subject is supplied at run time, because the point of a
 * benchmark is to run *your* system against a *standard* workload) plus its
 * dataset and a README stating version history and known limits.
 *
 * Teams check in a baseline bundle and gate releases with
 * `genesis run-benchmark <name> --subject "<cmd>"` +
 * `genesis regression --base <baseline> --candidate <current>`
 * (see templates/ci/).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, type EvalSpec } from "./spec.js";
import { fromRecords } from "./dataset.js";

export interface BenchmarkInfo {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly task_count: number;
  readonly metrics: readonly string[];
  readonly dir: string;
}

export class BenchmarkError extends Error {
  override readonly name = "BenchmarkError";
}

/** Locate the registry: explicit dir, ./benchmarks under cwd, or the shipped one. */
export function resolveRegistry(customDir?: string): string {
  const candidates: string[] = [];
  if (customDir) candidates.push(resolve(customDir));
  candidates.push(resolve(process.cwd(), "benchmarks"));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, "..", "..", "benchmarks"));
  } catch {
    // fileURLToPath unavailable — fall through to the candidates above.
  }
  for (const dir of candidates) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // try next
    }
  }
  throw new BenchmarkError(
    `no benchmark registry found (tried ${candidates.join(", ")}); pass --registry <dir>`,
  );
}

export function listBenchmarks(registryDir?: string): BenchmarkInfo[] {
  const dir = resolveRegistry(registryDir);
  const out: BenchmarkInfo[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const sub = join(dir, entry);
    const specFile = join(sub, "benchmark.yaml");
    try {
      if (!statSync(sub).isDirectory() || !statSync(specFile).isFile()) continue;
    } catch {
      continue;
    }
    const { spec, meta } = readBenchmarkFile(specFile);
    let taskCount = 0;
    try {
      const loaded = spec.dataset.inline
        ? fromRecords(spec.dataset.inline, entry, "1")
        : null;
      taskCount = loaded ? loaded.tasks.length : countDatasetLines(spec, sub);
    } catch {
      taskCount = -1;
    }
    out.push({
      name: entry,
      version: meta.version,
      description: meta.description,
      task_count: taskCount,
      metrics: spec.metrics ?? [],
      dir: sub,
    });
  }
  return out;
}

/** Load a benchmark spec, resolving relative dataset paths against its directory. */
export function loadBenchmark(name: string, registryDir?: string): { spec: EvalSpec; dir: string; version: string } {
  const dir = resolveRegistry(registryDir);
  const sub = join(dir, name);
  const specFile = join(sub, "benchmark.yaml");
  try {
    if (!statSync(specFile).isFile()) throw new Error("missing");
  } catch {
    throw new BenchmarkError(`benchmark "${name}" not found in ${dir}`);
  }
  const { spec, meta } = readBenchmarkFile(specFile);
  if (spec.dataset.path && !isAbsolute(spec.dataset.path)) {
    return { spec: { ...spec, name }, dir: sub, version: meta.version };
  }
  return { spec, dir: sub, version: meta.version };
}

/** Resolve a benchmark's dataset path to an absolute path. */
export function resolveBenchmarkDataset(spec: EvalSpec, dir: string): EvalSpec {
  if (spec.dataset.path && !isAbsolute(spec.dataset.path)) {
    return { ...spec, dataset: { ...spec.dataset, path: join(dir, spec.dataset.path) } };
  }
  return spec;
}

function readBenchmarkFile(specFile: string): { spec: EvalSpec; meta: { version: string; description: string } } {
  const raw = readFileSync(specFile, "utf8");
  const spec = parseSpec(raw, specFile);
  return { spec, meta: readMeta(specFile) };
}

function readMeta(specFile: string): { version: string; description: string } {
  const raw = readFileSync(specFile, "utf8");
  const lines = raw.split(/\r?\n/);
  // Only honor keys inside a top-level `benchmark:` block.
  const start = lines.findIndex((l) => /^benchmark:\s*(#.*)?$/.test(l));
  if (start < 0) return { version: "1", description: "" };
  let version = "1";
  let description = "";
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // next top-level key ends the block
    const m = line.match(/^\s+(version|description):\s*["']?(.+?)["']?\s*(#.*)?$/);
    if (m?.[1] === "version" && m[2]) version = m[2];
    if (m?.[1] === "description" && m[2]) description = m[2];
  }
  return { version, description };
}

function countDatasetLines(spec: EvalSpec, sub: string): number {
  const p = spec.dataset.path;
  if (!p) return spec.dataset.inline?.length ?? -1;
  const full = isAbsolute(p) ? p : join(sub, p);
  const text = readFileSync(full, "utf8");
  if (full.endsWith(".jsonl")) return text.split(/\r?\n/).filter((l) => l.trim()).length;
  try {
    const data: unknown = JSON.parse(text);
    return Array.isArray(data) ? data.length : 1;
  } catch {
    return text.split(/\r?\n/).filter((l) => l.trim()).length;
  }
}
