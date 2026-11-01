// Run ledger — every agent run persists here: run_id, profile, model, step records
// (tool, argsHash, durationMs, tokens, cost), stop reason, total cost.
// SQLite via node:sqlite (WAL for concurrent writer/reader between worker + server).
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "./sqlite.js";
import { dataDir } from "./trace.js";

let db = null;
export function runsDbPath() {
  return join(dataDir(), "runs.db");
}
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* ignore */ }
}
function isBusy(e) {
  return /busy|locked/i.test(String(e?.message ?? e?.errstr ?? e));
}
export function open() {
  if (db) return db;
  mkdirSync(dataDir(), { recursive: true });
  let lastErr = null;
  // A forked worker may hold a write lock (WAL) while this process opens the DB
  // (e.g. server reconciling while a worker streams steps). Retry instead of
  // throwing SQLITE_BUSY on first contention.
  for (let i = 0; i < 25; i++) {
    let handle = null;
    try {
      handle = new DatabaseSync(runsDbPath());
      handle.exec("PRAGMA busy_timeout=5000");
      handle.exec("PRAGMA journal_mode=WAL");
      handle.exec("PRAGMA synchronous=NORMAL");
      handle.exec(`CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    model TEXT NOT NULL,
    objective TEXT NOT NULL,
    organism_id TEXT,
    worker_pid INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    stop_reason TEXT,
    step_count INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    total_cost REAL DEFAULT 0,
    outcome TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    parent_run_id TEXT
  )`);
      handle.exec(`CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step INTEGER NOT NULL,
    kind TEXT,
    tool TEXT,
    args_hash TEXT,
    duration_ms INTEGER,
    tokens INTEGER DEFAULT 0,
    cost REAL DEFAULT 0,
    result_summary TEXT,
    ts TEXT NOT NULL
  )`);
      handle.exec("CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id)");
      // Tool-result stash (context hygiene L1): full text of truncated tool
      // results, keyed per run + ref. The agent pages through it on demand via
      // the context.retrieve tool; rows older than 7 days are pruned on write.
      handle.exec(`CREATE TABLE IF NOT EXISTS tool_result_stash (
    run_key TEXT NOT NULL,
    ref TEXT NOT NULL,
    tool TEXT,
    full_text TEXT NOT NULL,
    capped INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_key, ref)
  )`);
      handle.exec("CREATE INDEX IF NOT EXISTS idx_stash_run ON tool_result_stash(run_key)");
      // Checkpoints: serialized loop state per run for resume (one row per run, upserted).
      handle.exec(`CREATE TABLE IF NOT EXISTS checkpoints (
    run_id TEXT PRIMARY KEY,
    step INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
      // Migration: columns added over time; ensure each exists. Parallel processes
      // (tests, server + workers) can race open() on a fresh DB, so a lost race
      // surfaces as "duplicate column" — absorbed, since the column now exists.
      // (ADD COLUMN has no IF NOT EXISTS.) Busy errors propagate to the retry loop.
      const cols = handle.prepare("PRAGMA table_info(runs)").all().map((c) => c.name);
      const ensureColumn = (name, ddl) => {
        if (cols.includes(name)) return;
        try { handle.exec(`ALTER TABLE runs ADD COLUMN ${ddl}`); }
        catch (e) { if (!/duplicate column/i.test(String(e?.message ?? e))) throw e; }
        cols.push(name);
      };
      ensureColumn("worker_pid", "worker_pid INTEGER");
      ensureColumn("model_resolution", "model_resolution TEXT");
      ensureColumn("unverified", "unverified INTEGER DEFAULT 0");
      ensureColumn("receipt", "receipt TEXT");
      ensureColumn("resumes", "resumes INTEGER DEFAULT 0");
      ensureColumn("outcome_family", "outcome_family TEXT");
      ensureColumn("outcome_hash", "outcome_hash TEXT");
      ensureColumn("profile_hash", "profile_hash TEXT");
      ensureColumn("env_hash", "env_hash TEXT");
      ensureColumn("parent_run_id", "parent_run_id TEXT");
      handle.exec("CREATE INDEX IF NOT EXISTS idx_runs_family ON runs(outcome_family)");
      // Variant deprecation: marks a family's outcome variant as dead with a reason.
      handle.exec(`CREATE TABLE IF NOT EXISTS deprecated_variants (
    family TEXT NOT NULL,
    outcome_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    deprecated_at TEXT NOT NULL,
    PRIMARY KEY (family, outcome_hash)
  )`);
      db = handle;
      return db;
    } catch (e) {
      lastErr = e;
      try { handle?.close(); } catch { /* ignore */ }
      if (!isBusy(e)) throw e;
      sleepSync(200);
    }
  }
  throw lastErr;
}

export function createRun({ profile, model, objective, organism_id = "default", outcome_family = null, profile_hash = null, env_hash = null, parent_run_id = null }) {
  const d = open();
  const runId = "run-" + randomUUID().slice(0, 12);
  d.prepare("INSERT INTO runs (run_id, profile, model, objective, organism_id, outcome_family, profile_hash, env_hash, parent_run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)")
    .run(runId, profile, model, objective, organism_id, outcome_family, profile_hash, env_hash, parent_run_id, new Date().toISOString());
  return runId;
}

// Atomic admission: ceiling checks AND the insert happen in one IMMEDIATE
// transaction, so concurrent admitters cannot both pass the check and
// overshoot the caps. Returns { run_id } or an honest { error } with no
// partial row (rollback). Reconcile BEFORE calling — process signaling must
// not hold the write lock. A busy ledger returns ledger_busy (retry), never
// a crash.
export function admitRun({ profile, model, objective, organism_id = "default", outcome_family = null, profile_hash = null, env_hash = null, parent_run_id = null, maxConcurrent = 4, dailyCapUsd = 25 }) {
  const d = open();
  try {
    d.exec("BEGIN IMMEDIATE");
  } catch (e) {
    if (isBusy(e)) return { error: "ledger_busy", hint: "run ledger is locked; retry the run" };
    throw e;
  }
  try {
    const running = d.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get().n;
    if (running >= maxConcurrent) {
      d.exec("ROLLBACK");
      return { error: "too_many_runs", running, max_concurrent: maxConcurrent, hint: "wait for a run to finish or raise APE_MAX_CONCURRENT_RUNS" };
    }
    if (dailyCapUsd > 0) {
      const spent = d.prepare("SELECT COALESCE(SUM(total_cost), 0) AS s FROM runs WHERE started_at >= ?").get(new Date(Date.now() - 86400000).toISOString()).s;
      if (spent >= dailyCapUsd) {
        d.exec("ROLLBACK");
        return { error: "daily_budget_exceeded", spent_usd: spent, daily_cap_usd: dailyCapUsd, hint: "raise APE_MAX_DAILY_USD or wait for the window to roll" };
      }
    }
    const runId = "run-" + randomUUID().slice(0, 12);
    d.prepare("INSERT INTO runs (run_id, profile, model, objective, organism_id, outcome_family, profile_hash, env_hash, parent_run_id, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)")
      .run(runId, profile, model, objective, organism_id, outcome_family, profile_hash, env_hash, parent_run_id, new Date().toISOString());
    d.exec("COMMIT");
    return { run_id: runId };
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
}

export function getRun(runId) {
  const d = open();
  const run = d.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
  if (!run) return { run_id: runId, status: "not_found", outcome_status: "not_found" };
  const steps = d.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY step").all(runId);
  return { ...run, steps, outcome_status: outcomeStatus(run) };
}

// Lifecycle vs outcome: status says whether the run is over; outcome_status
// says what that means. Consumers (hosts, A2A) must branch on outcome_status,
// never infer success from status=done. Computed, not stored — the stop_reason
// history stays the source of truth.
export function outcomeStatus({ status, stop_reason, unverified } = {}) {
  if (status === "running") return "running";
  if (status === "not_found") return "not_found";
  if (status === "stopped") return stop_reason === "cancelled" ? "cancelled" : "stopped";
  switch (stop_reason) {
    case "explicit_final_answer": return unverified ? "unverified" : "success";
    case "dedup_reuse": return "success";
    case "no_tool_call_in_step": return "incomplete";
    case "max_steps":
    case "max_tokens":
    case "max_usd":
    case "max_wall_seconds":
    case "spend_capped":
      return "exhausted";
    default: return "failed";
  }
}

export function listRuns(limit = 20) {
  const d = open();
  return d.prepare("SELECT run_id, profile, model, status, stop_reason, step_count, total_cost, total_tokens, started_at, finished_at FROM runs ORDER BY started_at DESC LIMIT ?").all(limit);
}

// Recent runs for one profile, newest first — used by the failure-feedback loop,
// the harness analyzer, and cost-per-outcome views. Includes the receipt JSON so
// consumers can read trajectory signals (drift, evidence, fan-out) per run.
export function recentRuns(profile, limit = 10) {
  const d = open();
  return d.prepare("SELECT run_id, status, stop_reason, model, total_cost, total_tokens, step_count, unverified, receipt, started_at FROM runs WHERE profile = ? ORDER BY started_at DESC LIMIT ?").all(profile, limit);
}

export function appendStep(runId, step) {
  const d = open();
  d.prepare("INSERT INTO steps (run_id, step, kind, tool, args_hash, duration_ms, tokens, cost, result_summary, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(runId, step.step, step.kind ?? "model", step.tool ?? null, step.argsHash ?? null, step.durationMs ?? 0, step.tokens ?? 0, step.cost ?? 0, String(step.resultSummary ?? "").slice(0, 300), new Date().toISOString());
}

export function updateRun(runId, patch) {
  const d = open();
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const cols = keys.map((k) => `${k} = ?`).join(", ");
  d.prepare(`UPDATE runs SET ${cols} WHERE run_id = ?`).run(...keys.map((k) => patch[k]), runId);
}

// Dedup lookup, fail-closed: a prior run is reusable ONLY when ALL hold —
// same family + organism, finished inside the window, terminal state was a
// VERIFIED success (explicit_final_answer, not unverified, not budget/drift
// halted), identical profile hash, identical env fingerprint, identical
// resolved model. Legacy rows (NULL hashes) never match. Any missing
// requirement returns null: when in doubt, rerun.
export function findDuplicate({ family, organism_id = "default", windowSec = 3600, excludeRunId = null, profileHash = null, envHash = null, model = null }) {
  if (!family || !(windowSec > 0) || !profileHash || !envHash || !model) return null;
  const d = open();
  const since = new Date(Date.now() - windowSec * 1000).toISOString();
  return d.prepare(`SELECT run_id, status, stop_reason, step_count, total_cost, total_tokens, outcome_hash, receipt, finished_at
    FROM runs WHERE outcome_family = ? AND organism_id = ? AND status = 'done'
    AND stop_reason = 'explicit_final_answer' AND (unverified IS NULL OR unverified = 0)
    AND profile_hash = ? AND env_hash = ? AND model = ?
    AND finished_at >= ? AND run_id != COALESCE(?, '')
    ORDER BY finished_at DESC LIMIT 1`).get(family, organism_id, profileHash, envHash, model, since, excludeRunId) ?? null;
}

// Cost-per-outcome + variant tracking for one family: how many runs, what they
// cost, which outcome variants appeared, and which are deprecated.
export function familyStats(family) {
  const d = open();
  const runs = d.prepare(`SELECT run_id, status, stop_reason, step_count, total_cost, outcome_hash, started_at, finished_at
    FROM runs WHERE outcome_family = ? ORDER BY started_at`).all(family);
  const done = runs.filter((r) => r.status === "done");
  const costs = done.map((r) => r.total_cost ?? 0);
  const variants = [...new Set(done.map((r) => r.outcome_hash).filter(Boolean))];
  const deprecated = d.prepare("SELECT outcome_hash, reason, deprecated_at FROM deprecated_variants WHERE family = ?").all(family);
  const depSet = new Set(deprecated.map((x) => x.outcome_hash));
  return {
    family,
    runs: runs.length,
    completed: done.length,
    total_cost_usd: Number(costs.reduce((a, b) => a + b, 0).toFixed(6)),
    avg_cost_usd: costs.length ? Number((costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(6)) : 0,
    avg_steps: done.length ? Number((done.reduce((a, r) => a + (r.step_count ?? 0), 0) / done.length).toFixed(1)) : 0,
    variants: variants.map((h) => ({ outcome_hash: h, deprecated: depSet.has(h) })),
    deprecated,
  };
}

export function deprecateVariant({ family, outcome_hash, reason }) {
  const d = open();
  d.prepare("INSERT INTO deprecated_variants (family, outcome_hash, reason, deprecated_at) VALUES (?, ?, ?, ?) ON CONFLICT(family, outcome_hash) DO UPDATE SET reason = excluded.reason, deprecated_at = excluded.deprecated_at")
    .run(family, outcome_hash, reason, new Date().toISOString());
  return { family, outcome_hash, reason };
}

// Janitor: workers are detached forks; if one dies before updateRun() (OOM, restart),
// its row would stay "running" forever. Reconcile by checking worker PIDs.
export function reconcileRuns({ graceMs = 60000 } = {}) {
  const d = open();
  const running = d.prepare("SELECT run_id, worker_pid, started_at FROM runs WHERE status = 'running'").all();
  let fixed = 0;
  const now = Date.now();
  for (const r of running) {
    let alive = false;
    if (r.worker_pid) {
      try { process.kill(r.worker_pid, 0); alive = true; } catch { alive = false; }
    }
    const age = now - new Date(r.started_at).getTime();
    if (!alive && age > graceMs) {
      d.prepare("UPDATE runs SET status = 'stopped', stop_reason = 'worker_gone', finished_at = ? WHERE run_id = ?")
        .run(new Date().toISOString(), r.run_id);
      fixed++;
    }
  }
  return { checked: running.length, fixed };
}

export function runningCount() {
  const d = open();
  return d.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'running'").get().n;
}

// Steps newer than a row id, across all runs (powers the SSE push channel).
export function stepsSince(lastId = 0, limit = 100) {
  const d = open();
  return d.prepare("SELECT s.*, r.profile FROM steps s JOIN runs r ON r.run_id = s.run_id WHERE s.id > ? ORDER BY s.id LIMIT ?").all(lastId, limit);
}

// Total USD across runs started since the given epoch-ms (for the daily ceiling).
export function spendSince(ms) {
  const d = open();
  return d.prepare("SELECT COALESCE(SUM(total_cost), 0) AS s FROM runs WHERE started_at >= ?").get(new Date(ms).toISOString()).s;
}

export function saveCheckpoint(runId, step, state) {
  const d = open();
  d.prepare("INSERT INTO checkpoints (run_id, step, state, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET step = excluded.step, state = excluded.state, updated_at = excluded.updated_at")
    .run(runId, step, JSON.stringify(state), new Date().toISOString());
}

export function loadCheckpoint(runId) {
  const d = open();
  const row = d.prepare("SELECT * FROM checkpoints WHERE run_id = ?").get(runId);
  if (!row) return null;
  try { return { ...row, state: JSON.parse(row.state) }; }
  catch { return null; }
}