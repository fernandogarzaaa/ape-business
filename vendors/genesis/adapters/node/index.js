/**
 * Genesis adapter protocol for Node (zero dependencies).
 *
 * Subject:
 *
 *   import { runSubject } from "../../adapters/node/index.js";
 *   await runSubject((task) => String(Number(task.input) * 2));
 *
 * External evaluator:
 *
 *   import { runEvaluator } from "../../adapters/node/index.js";
 *   await runEvaluator((task, output) => ({ passed: output === task.reference }));
 */

import { readFileSync } from "node:fs";

function argOrEnv(position, envName) {
  if (process.argv[position]) return process.argv[position];
  const value = process.env[envName];
  return value ? value : null;
}

/** Load the task JSON from argv[2] or GENESIS_TASK_FILE. */
export function loadTask(path) {
  const resolved = path ?? argOrEnv(2, "GENESIS_TASK_FILE");
  if (!resolved) {
    throw new Error("genesis_adapter: expected a task file as argv[2] or GENESIS_TASK_FILE");
  }
  const task = JSON.parse(readFileSync(resolved, "utf8"));
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("genesis_adapter: task file must hold a JSON object");
  }
  return task;
}

/**
 * Load the subject output from argv[3] or GENESIS_OUTPUT_FILE.
 * Returns { value, raw } where value is parsed JSON when possible.
 */
export function loadOutput(path) {
  const resolved = path ?? argOrEnv(3, "GENESIS_OUTPUT_FILE");
  if (!resolved) {
    throw new Error("genesis_adapter: expected an output file as argv[3] or GENESIS_OUTPUT_FILE");
  }
  const raw = readFileSync(resolved, "utf8");
  try {
    return { value: JSON.parse(raw), raw };
  } catch {
    return { value: raw, raw };
  }
}

/** Subject envelope: strings verbatim, everything else as JSON. */
export function formatOutput(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Evaluator envelope: bool/number/object → JSON with passed/score. */
export function formatVerdict(value) {
  if (typeof value === "boolean") return JSON.stringify({ passed: value });
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`evaluator score must be finite, got ${value}`);
    return JSON.stringify({ score: value });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (!("passed" in value) && !("score" in value)) {
      throw new Error("evaluator object must contain 'passed' and/or 'score'");
    }
    return JSON.stringify(value);
  }
  throw new Error(`evaluator must return boolean, number, or object — got ${Array.isArray(value) ? "array" : typeof value}`);
}

/** Run a subject function (may be async): load task → fn(task) → stdout. Exit 1 on error. */
export async function runSubject(fn) {
  try {
    const task = loadTask();
    const out = formatOutput(await fn(task));
    process.stdout.write(out);
    if (!out.endsWith("\n")) process.stdout.write("\n");
  } catch (error) {
    process.stderr.write(`genesis_adapter subject error: ${(error && error.message) || error}\n`);
    process.exitCode = 1;
  }
}

/** Run an evaluator function (may be async): load task+output → fn → JSON envelope. */
export async function runEvaluator(fn) {
  try {
    const task = loadTask();
    const { value } = loadOutput();
    const out = formatVerdict(await fn(task, value));
    process.stdout.write(out);
    if (!out.endsWith("\n")) process.stdout.write("\n");
  } catch (error) {
    // Diagnosable envelope AND failure: without passed/score Genesis records
    // the trial as unjudged rather than inventing a verdict.
    process.stdout.write(`${JSON.stringify({ error: (error && error.message) || String(error) })}\n`);
    process.stderr.write(`genesis_adapter evaluator error: ${(error && error.message) || error}\n`);
    process.exitCode = 1;
  }
}
