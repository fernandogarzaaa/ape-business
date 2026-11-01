#!/usr/bin/env node
/**
 * A deliberately defective verifier.
 *
 * Every shortcut here is one taken by real harnesses, and each corresponds to a
 * defect class in `src/assurance/taxonomy.ts`:
 *
 *   math — accepts if ANY number anywhere in the completion is within a wide
 *          tolerance, and never requires the answer marker.
 *   json — scavenges candidate objects out of prose and accepts if any one of
 *          them has the required keys with the right types.
 *   code — runs only the visible tests, with no wall-clock bound, and treats
 *          encouraging stdout as evidence of success.
 *
 * Usage: node naive.mjs <task.json> <completion.txt>   →   {"reward":0|1}
 */

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
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

// ── math: loose extraction, loose tolerance, no marker required ──
function judgeMath(task, completion) {
  const target = Number(task.reference);
  const numbers = [...completion.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  // DEFECT: any number in the text will do.
  return numbers.some((n) => Math.abs(n - target) <= 0.5);
}

// ── json: scavenge from prose, structural checks only ──
function judgeJson(task, completion) {
  // DEFECT: pull every brace-delimited candidate out of surrounding text.
  const candidates = [...completion.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]);
  const required = task.schema?.required ?? [];
  const properties = task.schema?.properties ?? {};

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate); // DEFECT: duplicate keys resolve silently.
    } catch {
      continue;
    }
    // DEFECT: required keys present with the right types is the whole check.
    const ok = required.every((key) => {
      const value = parsed[key];
      const spec = properties[key];
      if (value === undefined) return false;
      if (spec?.type === "string") return typeof value === "string";
      return true;
    });
    if (ok) return true; // DEFECT: extra fields never examined.
  }
  return false;
}

// ── code: visible tests only, no timeout, stdout believed ──
function judgeCode(task, completion) {
  const dir = mkdtempSync(join(tmpdir(), "naive-"));
  const runner = join(dir, "run.mjs");

  const assertions = (task.visible_tests ?? [])
    .map((t) => `if (!(${t})) process.exit(1);`)
    .join("\n");
  writeFileSync(runner, `${completion}\n${assertions}\n`, "utf8");

  // DEFECT: no timeout. A completion that hangs hangs the harness.
  const result = spawnSync(process.execPath, [runner], { encoding: "utf8" });
  const stdout = result.stdout ?? "";

  // DEFECT: encouraging output counts as a pass.
  if (/\b(pass|passed|ok)\b/i.test(stdout)) return true;
  return result.status === 0;
}
