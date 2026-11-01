// Global operator config — ape.config.yaml (falls back to ape.config.example.yaml).
// This is the source of global defaults for the agent loop; profile policy
// overrides individual fields. Loaded lazily and cached per process; the file is
// re-read on next process start (workers are forked per run, so edits apply to
// new runs without a server restart).
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let cached = null;

export function globalConfigPath() {
  const p = join(root, "ape.config.yaml");
  if (existsSync(p)) return p;
  const ex = join(root, "ape.config.example.yaml");
  return existsSync(ex) ? ex : null;
}

export function loadGlobalConfig() {
  if (cached) return cached;
  let raw = {};
  let path = null;
  try {
    path = globalConfigPath();
    if (path) raw = YAML.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    raw = {};
  }
  cached = { path, context: raw?.context && typeof raw.context === "object" ? raw.context : {} };
  return cached;
}

// Test hook: drop the cache so a rewritten config file is picked up.
export function clearGlobalConfigCache() {
  cached = null;
}
