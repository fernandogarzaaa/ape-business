#!/usr/bin/env node
/**
 * A verifier written to resist the taxonomy.
 *
 * Not "correct" in any general sense — it is the reference the naive verifier is
 * measured against, and it exists to show the probe suite discriminates rather
 * than merely rejecting everything. It must accept every control probe.
 *
 *   math — requires exactly one \boxed{}, compares exactly.
 *   json — requires the whole completion to be one document, rejects duplicate
 *          keys by raw scan, rejects undeclared fields, compares semantically.
 *   code — runs visible AND held-out tests, bounded by a wall clock, and reads
 *          results from a file the harness controls rather than from stdout.
 *
 * Usage: node strict.mjs <task.json> <completion.txt>   →   {"reward":0|1}
 */

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , taskFile, completionFile] = process.argv;
const task = JSON.parse(readFileSync(taskFile, "utf8"));
const completion = readFileSync(completionFile, "utf8");

const reward = judge(task, completion) ? 1 : 0;
process.stdout.write(JSON.stringify({ reward }) + "\n");

function judge(task, completion) {
  if (task.visible_tests) return judgeCode(task, completion);
  if (task.schema) return judgeJson(task, completion);
  return judgeMath(task, completion);
}

// ── math ──
function judgeMath(task, completion) {
  const boxed = [...completion.matchAll(/\\boxed\{([^}]*)\}/g)].map((m) => m[1]);
  // Exactly one marked answer: zero means unmarked, several means uncommitted.
  if (boxed.length !== 1) return false;

  const value = Number(boxed[0].trim());
  if (!Number.isFinite(value)) return false;
  return value === Number(task.reference);
}

// ── json ──
function judgeJson(task, completion) {
  const trimmed = completion.trim();
  // One document, not a document embedded in prose.
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;

  if (hasDuplicateKeys(trimmed)) return false;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }

  const properties = task.schema?.properties ?? {};
  const allowed = new Set(Object.keys(properties));
  if (task.schema?.additionalProperties === false) {
    for (const key of Object.keys(parsed)) {
      if (!allowed.has(key)) return false;
    }
  }

  let reference;
  try {
    reference = JSON.parse(task.reference);
  } catch {
    return false;
  }

  // Semantic comparison: key order and whitespace must not matter.
  const keys = Object.keys(reference);
  if (Object.keys(parsed).length !== keys.length) return false;
  return keys.every((key) => parsed[key] === reference[key]);
}

/** Raw scan — JSON.parse resolves duplicates silently, so it cannot detect them. */
function hasDuplicateKeys(text) {
  const seen = new Set();
  for (const match of text.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"\s*:/g)) {
    if (seen.has(match[1])) return true;
    seen.add(match[1]);
  }
  return false;
}

// ── code ──
function judgeCode(task, completion) {
  const dir = mkdtempSync(join(tmpdir(), "strict-"));
  // .cjs so `require` is available and the completion's top-level declarations
  // are in scope for the assertions below.
  const runner = join(dir, "run.cjs");
  const resultsFile = join(dir, "results.json");

  const tests = [...(task.visible_tests ?? []), ...(task.hidden_tests ?? [])];
  const harness = `
${completion}
;(function () {
  var __tests = ${JSON.stringify(tests)};
  var __passed = 0;
  for (var __i = 0; __i < __tests.length; __i++) {
    try { if (eval(__tests[__i]) === true) __passed++; } catch (e) {}
  }
  require("node:fs").writeFileSync(
    ${JSON.stringify(resultsFile)},
    JSON.stringify({ passed: __passed, total: __tests.length })
  );
})();
`;
  writeFileSync(runner, harness, "utf8");

  // Bounded. A completion that hangs is killed and produces no results.
  spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    timeout: 5000,
    killSignal: "SIGKILL",
  });

  // Results come from a file we named, not from anything the completion printed.
  // A completion that calls process.exit(0) early never writes it.
  if (!existsSync(resultsFile)) return false;

  try {
    const results = JSON.parse(readFileSync(resultsFile, "utf8"));
    return results.total > 0 && results.passed === results.total;
  } catch {
    return false;
  }
}
