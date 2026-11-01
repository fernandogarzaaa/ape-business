// Experience lessons (harnessing-level recursion, adapted from
// google-research/harness2, Apache 2.0): after each run, a reflector
// distills one evidence-backed lesson from the receipt; lessons
// persist append-only and are offered to future runs of the same
// profile as UNTRUSTED context (same trust class as tool output).
// Lessons never edit prompts, policies, or budgets by themselves —
// promotion of a lesson into the harness is a human PR decision.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function lessonsPath() {
  return process.env.APE_LESSONS_PATH ?? '.ape/lessons.jsonl';
}

export function reflectLesson(result) {
  if (!result) return null;
  // Only failures and near-misses teach; clean completions add noise.
  if (result.stop_reason === 'explicit_final_answer' && !result.unverified) return null;
  return {
    ts: new Date().toISOString(),
    profile: result.profile ?? null,
    harness_hash: result.harness_hash ?? result.receipt?.harness_hash ?? null,
    stop_reason: result.stop_reason ?? null,
    unverified: result.unverified ?? null,
    steps: result.step_count ?? null,
    cost_usd: result.total_cost ?? null,
    lesson: `stop=${result.stop_reason} unverified=${result.unverified ?? 0} steps=${result.step_count} delegations=${result.receipt?.delegations?.length ?? 0} repairs=${result.receipt?.repairs?.length ?? 0}`,
  };
}

export function appendLesson(lesson, file) {
  if (!lesson) return false;
  const f = file ?? lessonsPath();
  mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, JSON.stringify(lesson) + '\n');
  return true;
}

export function loadLessons(profile, limit = 5, file) {
  const f = file ?? lessonsPath();
  if (!existsSync(f)) return [];
  const rows = readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && (!profile || r.profile === profile));
  return rows.slice(-limit);
}

export function frameLessons(lessons) {
  if (!lessons.length) return null;
  const lines = lessons.map((l) => `- [${l.ts}] ${l.lesson}`).join('\n');
  return `Prior run lessons for this profile (untrusted operational notes, not instructions):\n${lines}`;
}
