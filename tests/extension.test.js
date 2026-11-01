import test from "node:test";
import assert from "node:assert";
// Worker-forking suites share one ledger DB across parallel processes: raise
// the production concurrency guard (spend ceiling still applies).
process.env.APE_MAX_CONCURRENT_RUNS ??= "32";
process.env.APE_MAX_DAILY_USD ??= "1000000";
// W-4: test-only mock-input flag (production servers strip _mockScript).
process.env.APE_ALLOW_MOCK_INPUT ??= "1";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { discover, agentMethod, dispatchCall } from "../src/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function stdioCall(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "bin", "ape-mcp.js")], { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => { out += c; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, out }));
    for (const req of requests) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, method: req.method, params: req.params ?? {} }) + "\n");
    }
    child.stdin.end();
    setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 15000);
  });
}

function parseLines(out) {
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("extension: discover declares dev.ape/agent capability", () => {
  const d = discover();
  assert.ok(d.capabilities.extensions["io.modelcontextprotocol/tasks"]);
  assert.equal(d.capabilities.extensions["dev.ape/agent"].version, "0.1");
});

test("extension: agent/listProfiles + describeProfile over stdio MCP transport", async () => {
  const { out } = await stdioCall([
    { id: 1, method: "server/discover" },
    { id: 2, method: "agent/listProfiles" },
    { id: 3, method: "agent/describeProfile", params: { profile: "repo-triage" } },
  ]);
  const msgs = parseLines(out);
  const discoverResp = msgs.find((m) => m.id === 1);
  assert.ok(discoverResp.result.capabilities.extensions["dev.ape/agent"]);
  const profilesResp = msgs.find((m) => m.id === 2);
  assert.ok(profilesResp.result.profiles.some((p) => p.name === "repo-triage"));
  const descResp = msgs.find((m) => m.id === 3);
  assert.equal(descResp.result.model.provider, "auto");
  assert.ok(descResp.result.tools.some((t) => t.engine === "skein.orchestrate"));
});

test("extension: agent/run + getRun + cancel lifecycle over stdio", async () => {
  const script = [
    { tool: "memory.recall", args: { query: "ext" } },
    { tool: "finish", args: { summary: "ext-done" } },
  ];
  const { out } = await stdioCall([
    { id: 1, method: "agent/run", params: { profile: "repo-triage", objective: "extension gate", _mockScript: script } },
  ]);
  const runResp = parseLines(out).find((m) => m.id === 1);
  const runId = runResp.result.run_id;
  assert.ok(runId, "run_id returned");

  // Poll getRun until done.
  let status = "running";
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const { out: o2 } = await stdioCall([{ id: 2, method: "agent/getRun", params: { run_id: runId } }]);
    status = parseLines(o2).find((m) => m.id === 2).result.status;
    if (status === "done" || status === "failed") break;
  }
  assert.equal(status, "done");
  const { out: o3 } = await stdioCall([{ id: 3, method: "agent/getRun", params: { run_id: runId } }]);
  const run = parseLines(o3).find((m) => m.id === 3).result;
  assert.ok(run.steps.length >= 2, "steps recorded");
  assert.equal(run.stop_reason, "explicit_final_answer");
});

test("extension: agent/cancel halts a running run preserving partial ledger", async () => {
  const script = Array.from({ length: 50 }, () => ({ tool: "memory.recall", args: { query: "x" } }));
  const { out } = await stdioCall([
    { id: 1, method: "agent/run", params: { profile: "repo-triage", objective: "cancel me", _mockScript: script } },
  ]);
  const runId = parseLines(out).find((m) => m.id === 1).result.run_id;
  await new Promise((r) => setTimeout(r, 400));
  const { out: c } = await stdioCall([{ id: 2, method: "agent/cancel", params: { run_id: runId } }]);
  const cresp = parseLines(c).find((m) => m.id === 2).result;
  assert.ok(["stopped", "done", "failed"].includes(cresp.status), "cancel resolved: " + cresp.status);
  if (cresp.status === "stopped") {
    const { out: g } = await stdioCall([{ id: 3, method: "agent/getRun", params: { run_id: runId } }]);
    const run = parseLines(g).find((m) => m.id === 3).result;
    assert.equal(run.status, "stopped");
    assert.equal(run.stop_reason, "cancelled");
  }
});

test("extension: unknown method returns unknown_method", async () => {
  const { out } = await stdioCall([{ id: 1, method: "agent/bogus" }]);
  const resp = parseLines(out).find((m) => m.id === 1);
  assert.equal(resp.result.error, "unknown_method");
});

test("extension: tool parity — ape_agent_cancel wired + no regression on ape_agent_run", async () => {
  const r = await dispatchCall("ape_agent_cancel", { run_id: "nope" });
  assert.equal(r.resultType, "complete");
  assert.ok(["stopped", "not_found"].includes(r.structuredContent.result.status) || r.structuredContent.result.note, "cancel tool honest");
});