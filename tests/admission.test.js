// Atomic admission: ceilings + insert in one transaction, no overshoot, no partial rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.APE_DATA_DIR = mkdtempSync(join(tmpdir(), "ape-admit-"));

const runs = await import("../src/runs.js");

test("admission: ok path inserts a running row", () => {
  const r = runs.admitRun({ profile: "p", model: "m", objective: "admit ok" });
  assert.ok(r.run_id, "run admitted");
  assert.equal(runs.getRun(r.run_id).status, "running");
});

test("admission: concurrency cap refuses without a partial row", () => {
  const before = runs.listRuns(1000).length;
  const a = runs.admitRun({ profile: "p", model: "m", objective: "cap one", maxConcurrent: 1000 });
  assert.ok(a.run_id);
  // Fill to the cap with direct running rows, then admit must refuse atomically.
  const filler = runs.createRun({ profile: "p", model: "m", objective: "cap filler" });
  const refused = runs.admitRun({ profile: "p", model: "m", objective: "cap over", maxConcurrent: 2 });
  assert.equal(refused.error, "too_many_runs");
  assert.equal(refused.max_concurrent, 2);
  assert.equal(runs.listRuns(1000).length, before + 2, "refused admit leaves no row");
  runs.updateRun(a.run_id, { status: "done", stop_reason: "explicit_final_answer", finished_at: new Date().toISOString() });
  runs.updateRun(filler, { status: "done", stop_reason: "explicit_final_answer", finished_at: new Date().toISOString() });
});

test("admission: daily spend cap refuses without a partial row", () => {
  const before = runs.listRuns(1000).length;
  const rich = runs.createRun({ profile: "p", model: "m", objective: "big spender" });
  runs.updateRun(rich, { status: "done", total_cost: 50, finished_at: new Date().toISOString() });
  const refused = runs.admitRun({ profile: "p", model: "m", objective: "over budget", maxConcurrent: 1000, dailyCapUsd: 25 });
  assert.equal(refused.error, "daily_budget_exceeded");
  assert.ok(refused.spent_usd >= 50);
  assert.equal(runs.listRuns(1000).length, before + 1, "refused admit leaves no row");
});
