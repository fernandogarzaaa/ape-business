// Durable tasks: no lost updates under concurrency, no torn writes on crash,
// stale reconciliation, TTL. The audit's acceptance cases, against SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync, spawn, execFile } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

process.env.APE_DATA_DIR = mkdtempSync(join(tmpdir(), "ape-tasks-"));

const tasks = await import("../src/tasks.js");
const tasksUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tasks.js")).href;

test("tasks: CRUD shape matches the file-backend contract", () => {
  const id = tasks.taskCreate("ape_status", { a: 1 });
  assert.ok(id.startsWith("task-"));
  const t = tasks.taskGet(id);
  assert.equal(t.status, "running");
  assert.deepEqual(t.arguments, { a: 1 });
  assert.equal(t.result, null);
  assert.ok(tasks.taskList().some((x) => x.id === id), "listed");
  assert.deepEqual(tasks.taskGet("task-nope"), { id: "task-nope", status: "not_found" });
  tasks.taskFinish("task-nope", null, null); // missing finish is a no-op, not a crash
  tasks.taskFinish(id, { ok: true }, null);
  const done = tasks.taskGet(id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.result, { ok: true });
  assert.ok(done.finished, "finished timestamp");
  const id2 = tasks.taskCreate("ape_status", {});
  tasks.taskFinish(id2, null, "boom");
  assert.equal(tasks.taskGet(id2).status, "failed");
  assert.equal(tasks.taskGet(id2).error, "boom");
});

test("tasks: legacy tasks.json migrates once, then retires", async () => {
  // Fresh data dir: migration only runs into an empty table.
  const fresh = mkdtempSync(join(tmpdir(), "ape-tasks-mig-"));
  writeFileSync(join(fresh, "tasks.json"), JSON.stringify({ tasks: {
    "task-old1": { id: "task-old1", tool: "ape_status", arguments: {}, status: "done", result: { ok: 1 }, error: null, created: "2026-01-01T00:00:00.000Z", finished: "2026-01-01T00:00:01.000Z" },
  } }));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `process.env.APE_DATA_DIR=${JSON.stringify(fresh)};const m=await import(${JSON.stringify(tasksUrl)});console.log(JSON.stringify(m.taskGet("task-old1")));`],
    { encoding: "utf8" });
  assert.equal(child.status, 0, "child ok: " + String(child.stderr).slice(0, 200));
  assert.equal(JSON.parse(child.stdout).status, "done", "legacy row imported");
  assert.ok(existsSync(join(fresh, "tasks.json.migrated")), "legacy file retired");
});

test("tasks: stale rows expire, live owners never do", () => {
  const dead = spawnSync(process.execPath, ["-e", ""]).pid; // exited → reaped → dead
  const orphan = tasks.taskCreate("t", {}, { ownerPid: dead });
  const live = tasks.taskCreate("t", {});
  // Creating `live` already ran the opportunistic reconcile: the dead-owner
  // orphan is expired without any explicit janitor call.
  assert.equal(tasks.taskGet(orphan).status, "expired", "dead owner reconciled");
  assert.match(tasks.taskGet(orphan).error, /task_expired/, "honest expiry reason");
  const r = tasks.taskReconcile();
  assert.equal(tasks.taskGet(live).status, "running", "live owner untouched");
  assert.ok(r.checked >= 1, "reconcile scans live rows");
  // A live owner is immune to age: even a zero grace must not expire it.
  tasks.taskReconcile({ graceMs: 0 });
  assert.equal(tasks.taskGet(live).status, "running", "live owner immune to grace window");
  tasks.taskFinish(live, { ok: 1 }, null);
});

test("tasks: TTL prunes ancient terminal rows only", async () => {
  const id = tasks.taskCreate("t", {});
  tasks.taskFinish(id, { ok: 1 }, null);
  assert.equal(tasks.taskPrune({ olderThanMs: 7 * 86400000 }).pruned, 0, "fresh rows kept");
  assert.equal(tasks.taskGet(id).status, "done");
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(tasks.taskPrune({ olderThanMs: 1 }).pruned >= 1, "rows older than the cutoff prune");
});

test("tasks: concurrent processes lose nothing (audit case)", async () => {
  const helper = join(process.env.APE_DATA_DIR, "burst.mjs");
  writeFileSync(helper, `const m=await import(process.argv[2]);const w=Number(process.argv[3]);for(let i=0;i<5;i++){const id=m.taskCreate("t",{worker:w,i});m.taskFinish(id,{worker:w,i});}console.log("w"+w);`);
  const procs = [0, 1, 2, 3].map((w) => new Promise((resolve, reject) => {
    execFile(process.execPath, [helper, tasksUrl, String(w)], (err, stdout, stderr) => {
      if (err) reject(new Error("worker " + w + ": " + stderr.slice(0, 200)));
      else resolve(stdout);
    });
  }));
  await Promise.all(procs);
  const all = tasks.taskList(1000);
  const burst = all.filter((t) => t.tool === "t" && t.arguments && typeof t.arguments.worker === "number");
  assert.equal(burst.length, 20, "all 20 concurrent tasks present");
  assert.ok(burst.every((t) => t.status === "done"), "all finished");
  assert.ok(burst.every((t) => t.result?.worker === t.arguments.worker && t.result?.i === t.arguments.i), "results match their tasks — no cross-talk");
});

test("tasks: kill -9 mid-burst leaves a valid database (audit case)", async () => {
  const helper = join(process.env.APE_DATA_DIR, "kill.mjs");
  writeFileSync(helper, `const m=await import(process.argv[2]);let i=0;while(true){const id=m.taskCreate("k",{i:i++});m.taskFinish(id,{i});}`);
  const child = spawn(process.execPath, [helper, tasksUrl], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 1500));
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  const { DatabaseSync } = await import("../src/sqlite.js");
  const { join: dj } = await import("node:path");
  const { dataDir } = await import("../src/trace.js");
  const check = new DatabaseSync(dj(dataDir(), "tasks.db"));
  assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok", "no torn database");
  check.close();
  const rows = tasks.taskList(10000).filter((t) => t.tool === "k");
  assert.ok(rows.length > 0, "burst rows readable after kill");
  tasks.taskReconcile({ graceMs: 0 });
  const after = tasks.taskList(10000).filter((t) => t.tool === "k");
  assert.ok(after.every((t) => t.status === "done" || t.status === "expired"), "no row stuck running forever — orphans expire");
});
