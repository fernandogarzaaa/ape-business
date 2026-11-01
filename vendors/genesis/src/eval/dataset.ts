/**
 * Dataset abstraction: JSON, JSONL, CSV, YAML-subset, text, directories,
 * inline arrays. Every dataset is immutable: identity + version + digest +
 * schema + task count + provenance.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import { canonicalize } from "../shared/canonical.js";
import type { DatasetInfo, EvalTask } from "./types.js";

export interface LoadedDataset {
  readonly info: DatasetInfo;
  readonly tasks: readonly EvalTask[];
}

export class DatasetError extends Error {
  override readonly name = "DatasetError";
}

export type DatasetFormat = "json" | "jsonl" | "csv" | "yaml" | "text" | "dir" | "auto";

export function loadDataset(input: {
  path?: string;
  inline?: readonly unknown[];
  stdin?: string;
  format?: DatasetFormat;
  id?: string;
  version?: string;
}): LoadedDataset {
  if (input.inline) return fromRecords(input.inline, input.id ?? "inline", input.version ?? "1");
  if (input.stdin !== undefined) return parseText(input.stdin, input.format ?? "auto", input.id ?? "stdin", input.version ?? "1", { source: "stdin" });
  if (!input.path) throw new DatasetError("dataset: one of path, inline, or stdin is required");
  const p = input.path;
  let st: Stats | undefined;
  try {
    st = statSync(p);
  } catch {
    throw new DatasetError(`dataset: path not found: ${p}`);
  }
  const format = input.format ?? "auto";
  if (st.isDirectory() || format === "dir") return fromDirectory(p, input.id, input.version);
  const text = readFileSync(p, "utf8");
  const resolved = format === "auto" ? guessFormat(p, text) : format;
  return parseText(text, resolved, input.id ?? p, input.version ?? "1", { source: "file", path: p });
}

function guessFormat(path: string, _text: string): DatasetFormat {
  if (path.endsWith(".jsonl")) return "jsonl";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".csv")) return "csv";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  if (path.endsWith(".txt")) return "text";
  return "jsonl";
}

function parseText(text: string, format: DatasetFormat, id: string, version: string, provenance: Record<string, unknown>): LoadedDataset {
  switch (format) {
    case "json": {
      const data = JSON.parse(text);
      const records = Array.isArray(data) ? data : [data];
      return fromRecords(records, id, version, provenance);
    }
    case "jsonl": {
      const records: unknown[] = [];
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        records.push(JSON.parse(t));
      }
      return fromRecords(records, id, version, provenance);
    }
    case "csv": {
      return fromRecords(parseCsv(text), id, version, provenance);
    }
    case "yaml": {
      return fromRecords(parseYamlList(text), id, version, provenance);
    }
    case "text":
    case "auto": {
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return fromRecords(lines.map((input) => ({ input })), id, version, provenance);
    }
    case "dir":
      throw new DatasetError("dataset: dir format requires a directory path");
  }
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const headers = splitCsvLine(lines[0] as string).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cells[i] ?? "").trim();
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseYamlList(text: string): unknown[] {
  const docs = text.split(/^\s*---\s*$/m).map((d) => d.trim()).filter(Boolean);
  if (docs.length > 1) return docs.map((d) => parseYamlBlock(d));
  const t = text.trim();
  if (t.startsWith("- ")) {
    return t.split(/^\s*-\s+/m).map((s) => s.trim()).filter(Boolean).map((s) => parseYamlBlock(s));
  }
  return [parseYamlBlock(t)];
}

function parseYamlBlock(block: string): unknown {
  const out: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:#\s][^:]*):\s*(.*)$/);
    if (!m) continue;
    const v = (m[2] as string).trim();
    out[(m[1] as string).trim()] = v === "true" ? true : v === "false" ? false : v === "null" || v === "~" ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return Object.keys(out).length > 0 ? out : block;
}

function fromDirectory(dir: string, id?: string, version?: string): LoadedDataset {
  const files = readdirSync(dir).sort();
  const records: unknown[] = [];
  for (const f of files) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) continue;
    if (f.endsWith(".json") || f.endsWith(".jsonl")) {
      const text = readFileSync(full, "utf8");
      try {
        const data = f.endsWith(".jsonl")
          ? text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
          : JSON.parse(text);
        for (const r of Array.isArray(data) ? data : [data]) records.push(r);
      } catch {
        records.push({ input: readFileSync(full, "utf8") });
      }
    } else {
      records.push({ input: readFileSync(full, "utf8"), metadata: { file: f } });
    }
  }
  return fromRecords(records, id ?? basename(dir), version ?? "1", { source: "dir", path: dir });
}

export function fromRecords(records: readonly unknown[], id: string, version: string, provenance: Record<string, unknown> = {}): LoadedDataset {
  const tasks: EvalTask[] = records.map((r, i) => normalizeTask(r, i));
  const digest = createHash("sha256").update(canonicalize(tasks)).digest("hex");
  const schema = inferSchema(tasks);
  return {
    info: {
      id,
      version,
      digest: `sha256:${digest}`,
      task_count: tasks.length,
      schema,
      provenance: { ...provenance, loaded_at: new Date().toISOString() },
    },
    tasks,
  };
}

function normalizeTask(r: unknown, i: number): EvalTask {
  const id = `task-${String(i + 1).padStart(4, "0")}`;
  if (typeof r === "string" || typeof r === "number" || typeof r === "boolean") {
    return { id, input: r };
  }
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const o = r as Record<string, unknown>;
    return {
      id: typeof o.id === "string" ? (o.id as string) : id,
      input: o.input ?? o.prompt ?? o.question ?? o.text ?? r,
      ...(o.context !== undefined ? { context: o.context } : {}),
      ...(o.expected !== undefined ? { expected: o.expected } : {}),
      ...(o.reference !== undefined ? { reference: o.reference } : {}),
      ...(o.answer !== undefined && o.reference === undefined ? { reference: o.answer } : {}),
      ...(o.constraints ? { constraints: o.constraints as Record<string, unknown> } : {}),
      ...(o.metadata ? { metadata: o.metadata as Record<string, unknown> } : {}),
      ...(Array.isArray(o.tags) ? { tags: o.tags as string[] } : {}),
      ...(o.labels && typeof o.labels === "object" && !Array.isArray(o.labels)
        ? { labels: o.labels as Record<string, unknown> }
        : {}),
      ...(typeof o.kind === "string" ? { kind: o.kind as EvalTask["kind"] } : {}),
      ...(typeof o.evaluation_instructions === "string" ? { evaluation_instructions: o.evaluation_instructions as string } : {}),
    };
  }
  return { id, input: r };
}

function inferSchema(tasks: readonly EvalTask[]): Record<string, string> {
  const keys = new Set<string>();
  for (const t of tasks) for (const k of Object.keys(t)) keys.add(k);
  const schema: Record<string, string> = {};
  for (const k of [...keys].sort()) {
    const types = new Set(tasks.map((t) => typeof (t as unknown as Record<string, unknown>)[k]));
    schema[k] = [...types].sort().join("|");
  }
  return schema;
}
