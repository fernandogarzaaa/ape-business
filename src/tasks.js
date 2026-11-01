// Background tasks (MCP Tasks-extension shape) — SQLite-backed for durability
// across processes. Every mutation touches only its own row (UPSERT/UPDATE by
// primary key): concurrent writers cannot lose each other's tasks, and commits
// are atomic (no torn tasks.json). Same function surface as the old file
// backend; plus reconcile (stale running → expired) and prune (TTL for
// terminal rows). One-time migration imports tasks.json, then retires it.
import { existsSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "./sqlite.js";
import { dataDir } from "./trace.js";

let db = null;
function tasksDbPath() {
  return join(dataDir(), "tasks.db");
}
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* ignore */ }
}
function isBusy(e) {
  return /busy|locked/i.test(String(e?.message ?? e?.errstr ?? e));
}
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
function parseJson(text, fallback = null) {
  try { return JSON.parse(text); }
  catch { return fallback; }
}
function open() {
  if (db) return db;
  mkdirSync(dataDir(), { recursive: true });
  let lastErr = null;
  for (let i = 0; i < 25; i++) {
    let handle = null;
    try {
      handle = new DatabaseSync(tasksDbPath());
      handle.exec("PRAGMA busy_timeout=5000");
      handle.exec("PRAGMA journal_mode=WAL");
      handle.exec("PRAGMA synchronous=NORMAL");
      handle.exec(`CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    tool TEXT NOT NULL,
    arguments TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'running',
    result TEXT,
    error TEXT,
    owner_pid INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  )`);
      handle.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
      migrateJson(handle);
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
// One-time upgrade: import file-backend rows, then retire tasks.json so two
// backends never diverge. Skipped when the table already has rows.
function migrateJson(handle) {
  const legacy = join(dataDir(), "tasks.json");
  let raw = null;
  try {
    if (!existsSync(legacy)) return;
    raw = JSON.parse(readFileSync(legacy, "utf8"));
  } catch { return; }
  const rows = Object.values(raw?.tasks ?? {});
  if (!rows.length) return;
  const count = handle.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  if (count > 0) return;
  const ins = handle.prepare("INSERT OR IGNORE INTO tasks (task_id, tool, arguments, status, result, error, owner_pid, created_at, updated_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const t of rows) {
    if (!t?.id) continue;
    ins.run(
      t.id, t.tool ?? "unknown", JSON.stringify(t.arguments ?? {}),
      t.status ?? "running", t.result == null ? null : JSON.stringify(t.result),
      t.error ?? null, null, t.created ?? new Date().toISOString(),
      t.finished ?? t.created ?? new Date().toISOString(), t.finished ?? null
    );
  }
  try { renameSync(legacy, legacy + ".migrated"); } catch { /* leave legacy in place */ }
}
function rowToTask(r) {
  if (!r) return null;
  const t = {
    id: r.task_id, tool: r.tool, arguments: parseJson(r.arguments, {}),
    status: r.status, created: r.created_at,
    result: r.result == null ? null : parseJson(r.result, null),
    error: r.error,
  };
  if (r.finished_at) t.finished = r.finished_at;
  return t;
}

export function taskCreate(tool, args, opts = {}) {
  const d = open();
  // Self-maintaining: every creation also reconciles stale rows and prunes
  // ancient terminal rows (both cheap, both bounded).
  try { taskReconcile(); } catch { /* never break admission */ }
  try { taskPrune(); } catch { /* never break admission */ }
  const id = "task-" + randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  d.prepare("INSERT INTO tasks (task_id, tool, arguments, status, result, error, owner_pid, created_at, updated_at) VALUES (?, ?, ?, 'running', NULL, NULL, ?, ?, ?)")
    .run(id, tool, JSON.stringify(args ?? {}), opts.ownerPid ?? process.pid, now, now);
  return id;
}
export function taskGet(id) {
  const d = open();
  // Malformed callers (stringified garbage degrades to {}) must get not_found,
  // not a driver throw: SQLite rejects undefined bindings.
  const key = typeof id === "string" ? id : "";
  const r = d.prepare("SELECT * FROM tasks WHERE task_id = ?").get(key);
  return rowToTask(r) ?? { id, status: "not_found" };
}
export function taskList(limit = 50) {
  const d = open();
  const n = Math.max(1, Math.min(Number(limit) || 50, 10000));
  return d.prepare("SELECT * FROM tasks ORDER BY rowid DESC LIMIT ?").all(n).map(rowToTask);
}
export function taskFinish(id, result, error) {
  if (typeof id !== "string" || !id) return false;
  const d = open();
  const now = new Date().toISOString();
  const r = d.prepare("UPDATE tasks SET status = ?, result = ?, error = ?, updated_at = ?, finished_at = ? WHERE task_id = ? AND status = 'running'")
    .run(error ? "failed" : "done", result == null ? null : JSON.stringify(result), error ?? null, now, now, id);
  return r.changes > 0;
}
// Stale running rows cannot run again — the executor was in-process. Expire
// when the owner is dead (restart/crash), or when there is no owner and the
// row is untouched past the grace window (legacy imports). A live owner NEVER
// expires by age: long tasks must keep their result, not lose it to the janitor.
export function taskReconcile({ graceMs = 60000, nowMs = Date.now() } = {}) {
  const d = open();
  const rows = d.prepare("SELECT task_id, owner_pid, updated_at FROM tasks WHERE status = 'running'").all();
  let expired = 0;
  const upd = d.prepare("UPDATE tasks SET status = 'expired', error = ?, updated_at = ?, finished_at = ? WHERE task_id = ? AND status = 'running'");
  const now = new Date(nowMs).toISOString();
  for (const r of rows) {
    const age = nowMs - new Date(r.updated_at).getTime();
    const ownerGone = r.owner_pid != null && !isAlive(r.owner_pid);
    const orphaned = r.owner_pid == null && age > graceMs;
    if (ownerGone || orphaned) {
      const why = ownerGone ? `owner pid ${r.owner_pid} gone` : `untouched for ${Math.round(age / 1000)}s`;
      if (upd.run(`task_expired: ${why}; executor was in-process and cannot resume`, now, now, r.task_id).changes > 0) expired++;
    }
  }
  return { checked: rows.length, expired };
}
// TTL for terminal rows (done/failed/expired). Generous default; 0 disables.
export function taskPrune({ olderThanMs = Number(process.env.APE_TASK_TTL_MS ?? 7 * 86400000) } = {}) {
  if (!(olderThanMs > 0)) return { pruned: 0 };
  const d = open();
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const r = d.prepare("DELETE FROM tasks WHERE status != 'running' AND finished_at IS NOT NULL AND finished_at < ?").run(cutoff);
  return { pruned: r.changes };
}
