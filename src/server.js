import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { dispatch, engineFail, eveEntry, runNode, failEve, genesisEntry } from "./dispatch.js";
import { emitTrace, newTraceId, shaShort, dataDir } from "./trace.js";
import { loadMods } from "./mods.js";
import { taskCreate, taskGet, taskList, taskFinish } from "./tasks.js";
import { adamCall } from "./adam-client.js";
import { loadProfile, listProfiles, describeProfile } from "./agent/profiles.js";
import { familyOf, profileHash, envFingerprint } from "./agent/outcomes.js";
import { createRun, getRun, updateRun, reconcileRuns, runningCount, spendSince, loadCheckpoint, familyStats, deprecateVariant, admitRun } from "./runs.js";
import { loadConnector, connectorList } from "./connectors.js";
import { detectActiveProvider, detectProviders } from "./agent/hostdetect.js";

const runningAgents = new Map();

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROTOCOL = "2026-07-28";
export { PROTOCOL };

export const TOOL_DEFS = [
  { name: "ape_status", description: "APE status: versions, vendored engines, mods", inputSchema: { type: "object", properties: { organism_id: { type: "string" } } }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_remember", description: "Store durable memory in ADAM organism (real stdio call to vendored adam-mcp)", inputSchema: { type: "object", properties: { kind: { type: "string" }, content: { type: "string" }, origin: { type: "string" }, confidence: { type: "number" }, organism_id: { type: "string" } }, required: ["content"] }, annotations: { readOnly: false, idempotent: false } },
  { name: "ape_recall", description: "Query ADAM memory + prior decisions (real stdio call to vendored adam-mcp)", inputSchema: { type: "object", properties: { query: { type: "string" }, kind: { type: "string" }, top_k: { type: "number" }, organism_id: { type: "string" } }, required: ["query"] }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_beliefs", description: "List ADAM beliefs or form one from evidence (real stdio call; statement form creates a new belief)", inputSchema: { type: "object", properties: { statement: { type: "string" }, origin: { type: "string" }, organism_id: { type: "string" } } }, annotations: { readOnly: false, idempotent: false } },
  { name: "ape_genome", description: "Current ADAM genome payload (values, goals, capabilities, policies)", inputSchema: { type: "object", properties: { organism_id: { type: "string" } } }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_mcp_eval", description: "EVE mcp-eval: schema, conformance + fuzz oracles against an MCP server target", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_validate_experience", description: "Run EVE human-loop simulation (personas, seeded, evidence-backed)", inputSchema: { type: "object", properties: { url: { type: "string" }, persona: { type: "string" }, goal: { type: "string" }, seed: { type: "number" } } }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_audit_claim", description: "Genesis: evaluate claim + adversarially audit verifier (SOUND/EXPLOITABLE)", inputSchema: { type: "object", properties: { suite: { type: "string" }, verifier: { type: "string" }, spec: { type: "string" } } }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_compare", description: "Genesis compare/regression between two run result dirs", inputSchema: { type: "object", properties: { run_a: { type: "string" }, run_b: { type: "string" } } }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_orchestrate", description: "Skein task-graph: graph/node-add/claim/release/status/log with evidence gate", inputSchema: { type: "object", properties: { op: { type: "string" }, node: { type: "string" }, agent_id: { type: "string" }, title: { type: "string" }, goal: { type: "string" }, context: { type: "string" }, constraints: { type: "string" }, completion: { type: "string" }, depends_on: { type: "string" } } }, annotations: { readOnly: false, idempotent: true } },
  { name: "ape_evolve", description: "ADAM evolution lifecycle: propose (auto-signals) -> EVE measure -> governed accept/reject (destructive: confirm)", inputSchema: { type: "object", properties: { proposal_id: { type: "string" }, action: { type: "string" }, kind: { type: "string" }, topic: { type: "string" }, organism_id: { type: "string" } } }, annotations: { readOnly: false, destructive: true, idempotent: false } },
  { name: "ape_report", description: "Fetch report artifacts (EVE run reports, genesis ledger, genesis report render)", inputSchema: { type: "object", properties: { ref: { type: "string" } } }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_task_start", description: "Start any APE tool as a background task (Tasks extension); poll with ape_task_get", inputSchema: { type: "object", properties: { tool: { type: "string" }, arguments: { type: "object" } }, required: ["tool"] }, annotations: { readOnly: false, idempotent: false } },
  { name: "ape_task_get", description: "Poll a background task (running/done/failed + result)", inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_agent_profiles", description: "List available agent profiles + their declared tools and limits", inputSchema: { type: "object", properties: { } }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_agent_run", description: "Invoke an agent profile against an objective; returns run_id immediately (poll ape_agent_status). provider/model override auto-detection", inputSchema: { type: "object", properties: { profile: { type: "string" }, objective: { type: "string" }, organism_id: { type: "string" }, provider: { type: "string" }, model: { type: "string" } }, required: ["profile", "objective"] }, annotations: { readOnly: false, idempotent: false } },
  { name: "ape_agent_status", description: "Poll an agent run: status, steps, cost, outcome", inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_agent_cancel", description: "Cancel a running agent run, preserving the partial ledger", inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] }, annotations: { readOnly: false, idempotent: false } },
  { name: "ape_agent_resume", description: "Resume a stopped/failed run from its last checkpoint with a replacement worker", inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] }, annotations: { readOnly: false, idempotent: false } },
  { name: "ape_agent_analyze", description: "Analyze a profile's recent runs and propose concrete profile edits (harness evolution from trajectories)", inputSchema: { type: "object", properties: { profile: { type: "string" }, window: { type: "number" }, record: { type: "boolean" } }, required: ["profile"] }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_agent_family", description: "Cost-per-outcome + variant tracking for an outcome family (pass family id or raw objective)", inputSchema: { type: "object", properties: { family: { type: "string" }, objective: { type: "string" } } }, annotations: { readOnly: true, idempotent: true } },
  { name: "ape_agent_deprecate", description: "Mark an outcome variant of a family as deprecated with a reason", inputSchema: { type: "object", properties: { family: { type: "string" }, outcome_hash: { type: "string" }, reason: { type: "string" } }, required: ["family", "outcome_hash", "reason"] }, annotations: { readOnly: false, idempotent: true } },
  { name: "ape_connector_call", description: "Call a user-defined connector operation (egress-allowlisted). destructive ops need confirm", inputSchema: { type: "object", properties: { connector: { type: "string" }, operation: { type: "string" }, input: { type: "object" }, confirm: { type: "boolean" } }, required: ["connector", "operation"] }, annotations: { readOnly: false, idempotent: false } },
  { name: "ape_connector_list", description: "List loaded connectors + their operations and egress hosts", inputSchema: { type: "object", properties: { } }, annotations: { readOnly: true, idempotent: true } },
];

// Truncation that preserves valid JSON. Slicing a serialized string can split
// mid-token and produce unparseable output that crashes clients — instead we shorten
// the VALUE (long strings, long arrays) until it fits, so the text is always
// parseable. structuredContent carries the full result regardless.
export function safeTruncate(value, maxChars) {
  const shorten = (v, cap) => {
    if (typeof v === "string") return v.length > cap ? v.slice(0, cap) + "…[truncated]" : v;
    if (Array.isArray(v)) {
      const items = v.length > 200 ? [...v.slice(0, 200), `…[${v.length - 200} more]`] : v;
      return items.map((x) => (typeof x === "string" ? x : shorten(x, cap)));
    }
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = shorten(x, cap);
      return o;
    }
    return v;
  };
  for (const cap of [1500, 500, 150, 40]) {
    const t = shorten(value, cap);
    if (JSON.stringify(t).length <= maxChars) return t;
  }
  return { truncated: true, note: "result exceeds display budget; see structuredContent for the full result" };
}

// Compact run summary for content.text: sufficient for the model to continue even
// when the host does not forward structuredContent. Full step ledger stays in
// structuredContent.result.steps.
export function runStatusSummary(result) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  const recent = steps.slice(-8).map((s) => ({
    step: s.step,
    kind: s.kind,
    tool: s.tool,
    summary: String(s.resultSummary ?? "").slice(0, 160),
  }));
  return {
    run_id: result.run_id,
    status: result.status,
    stop_reason: result.stop_reason,
    model: result.model,
    resolution: result.model_resolution,
    steps: result.step_count,
    cost_usd: result.total_cost,
    tokens: result.total_tokens,
    outcome: String(result.outcome ?? "").slice(0, 800),
    recent_steps: recent,
    steps_omitted: Math.max(0, steps.length - recent.length),
  };
}

// W-4: mock-test controls must never arrive via production inputs. MCP schemas
// are descriptive and extra properties are not rejected, so _mockScript /
// _mockCostPerCall are stripped unless the test-only APE_ALLOW_MOCK_INPUT=1 is
// set in the server's own environment (unreachable to remote callers).
export function stripMockInput(a) {
  if (!a || typeof a !== "object") return a;
  if (process.env.APE_ALLOW_MOCK_INPUT !== "1") {
    delete a._mockScript;
    delete a._mockCostPerCall;
  }
  return a;
}

// Resume a stopped/failed run from its last checkpoint with a replacement worker.
// Refuses live workers, finished runs, missing checkpoints, and resume-cap excess.
function resumeRun(runId, workerOpts = {}) {
  reconcileRuns();
  const run = getRun(runId);
  if (!run || run.status === "not_found") return { error: "run_not_found", run_id: runId };
  if (run.status === "done") return { error: "run_finished", run_id: runId, status: run.status, hint: "completed runs cannot resume" };
  const w = runningAgents.get(runId);
  if (w) return { error: "run_active", run_id: runId, hint: "a live worker owns this run; cancel first to take over" };
  if (run.status === "running") {
    if (run.worker_pid) {
      try { process.kill(run.worker_pid, 0); return { error: "run_active", run_id: runId, hint: "worker process still alive; cancel first" }; }
      catch { /* pid dead — fall through to resume */ }
    } else {
      return { error: "run_active", run_id: runId, hint: "run is marked running with no dead worker proof; cancel first" };
    }
  }
  const maxResumes = Number(process.env.APE_MAX_RESUMES ?? 3);
  if ((run.resumes ?? 0) >= maxResumes) {
    return { error: "resume_cap_reached", run_id: runId, resumes: run.resumes, max: maxResumes };
  }
  const cp = loadCheckpoint(runId);
  if (!cp) return { error: "no_checkpoint", run_id: runId, hint: "this run predates checkpointing or never reached a model turn" };
  const ceiling = checkRunCeilings();
  if (ceiling) return ceiling;
  const profile = loadProfile(run.profile);
  if (!profile) return { error: "profile_not_found", profile: run.profile };
  updateRun(runId, {
    status: "running",
    stop_reason: null,
    finished_at: null,
    resumes: (run.resumes ?? 0) + 1,
  });
  const worker = fork(join(root, "src", "agent", "worker.js"), [runId, JSON.stringify({ ...workerOpts, resume: true })], { stdio: ["ignore", "ignore", "inherit", "ipc"], detached: true, execArgv: [] });
  worker.unref();
  updateRun(runId, { worker_pid: worker.pid });
  worker.on("exit", () => runningAgents.delete(runId));
  runningAgents.set(runId, worker);
  return { run_id: runId, status: "running", resumed_from_step: cp.step, resumes: (run.resumes ?? 0) + 1, poll: "ape_agent_status" };
}

// Run-level ceilings above any single run's budget: cap concurrent forks and total
// daily spend. Env-overridable; honest errors, never silent drops.
function checkRunCeilings() {
  reconcileRuns();
  const maxConcurrent = Number(process.env.APE_MAX_CONCURRENT_RUNS ?? 4);
  if (runningCount() >= maxConcurrent) {
    return { error: "too_many_runs", running: runningCount(), max_concurrent: maxConcurrent, hint: "wait for a run to finish or raise APE_MAX_CONCURRENT_RUNS" };
  }
  const dailyCap = Number(process.env.APE_MAX_DAILY_USD ?? 25);
  if (dailyCap > 0) {
    const spent = spendSince(Date.now() - 86400000);
    if (spent >= dailyCap) {
      return { error: "daily_budget_exceeded", spent_usd: spent, daily_cap_usd: dailyCap, hint: "raise APE_MAX_DAILY_USD or wait for the window to roll" };
    }
  }
  return null;
}

export async function dispatchCall(name, args = {}, ctx = {}) {
  const t0 = Date.now();
  const traceId = ctx.traceId || newTraceId();
  const mods = await loadMods(root);
  // MCP hosts may deliver `arguments` as a JSON string (e.g. opencode) or an object.
  let a;
  if (typeof args === "string") {
    try { a = JSON.parse(args) || {}; } catch { a = {}; }
  } else {
    a = { ...(args ?? {}) };
  }
  for (const m of mods) { try { if (m.hooks?.preCall) a = (await m.hooks.preCall(name, a, ctx)) ?? a; } catch (e) { emitTrace({ traceId, tool: name, modApplied: m.name + ":preCall-error" }); } }
  // MRTR-style confirm for destructive evolve without explicit confirm
  if (name === "ape_evolve" && (a.action === "accept" || a.action === "apply") && a.confirm !== true && !ctx.headlessBypass) {
    const dur = Date.now() - t0;
    emitTrace({ traceId, tool: name, argsHash: shaShort(JSON.stringify(a)), durationMs: dur, resultSummary: "input_required:confirm" });
    return { resultType: "input_required", traceId, inputRequests: [{ id: "confirm-evolve", type: "elicitation", message: "Accepting a genome mutation is destructive. Confirm?", schema: { confirm: "boolean" } }], requestState: shaShort(traceId + name) };
  }
  let result;
  try {
    switch (name) {
      case "ape_status": {
        const base = dispatch.status(a);
        // Never expose key/token material on any tool-visible surface.
        const active = await detectActiveProvider();
        const safeActive = active ? (({ key, token, ...rest }) => rest)(active) : null;
        result = {
          ...base,
          active_provider: safeActive,
          detected_providers: await detectProviders(),
        };
        break;
      }
      case "ape_remember": result = await adamCall("adam_memory_store", { kind: a.kind || "episodic", content: a.content, origin: a.origin || "observation", confidence: a.confidence ?? 0.9 }, a.organism_id); break;
      case "ape_recall": result = await adamCall("adam_memory_query", { query: a.query, kind: a.kind, top_k: a.top_k ?? 5 }, a.organism_id); break;
      case "ape_beliefs": result = await adamCall("adam_beliefs", a.statement ? { statement: a.statement, origin: a.origin || "observation" } : {}, a.organism_id); break;
      case "ape_genome": result = await adamCall("adam_genome", {}, a.organism_id); break;
      case "ape_mcp_eval": {
        const e = eveEntry();
        result = e ? await runNode(e, ["mcp-eval", a.target]) : failEve();
        break;
      }
      case "ape_validate_experience": result = await dispatch.validate_experience(a); break;
      case "ape_audit_claim": result = await dispatch.audit_claim(a); break;
      case "ape_compare": result = await dispatch.compare(a); break;
      case "ape_orchestrate": result = await dispatch.orchestrate(a); break;
      case "ape_evolve": {
        const org = a.organism_id || "default";
        if (a.action === "accept" || a.action === "apply") {
          result = await adamCall("adam_accept_mutation", { proposal_id: a.proposal_id }, org);
        } else if (a.action === "reject") {
          result = await adamCall("adam_reject_mutation", { proposal_id: a.proposal_id }, org);
        } else if (a.action === "propose") {
          result = await adamCall("adam_propose_mutation", { kind: a.kind || "amend_genome", topic: a.topic }, org);
        } else {
          result = await adamCall("adam_evolve", a, org);
        }
        break;
      }
      case "ape_report": {
        if (a.ref && existsSync(a.ref)) {
          const e = genesisEntry();
          result = e ? await runNode(e, ["report", a.ref]) : engineFail("genesis", "dist not built; run npm run build in vendors/genesis");
        } else {
          const dir = dataDir();
          const names = ["eve-report", "ledger.jsonl", "genesis-ledger.db", "tasks.json"];
          const artifacts = names.map((n) => ({ name: n, present: existsSync(join(dir, n)), uri: n === "eve-report" ? "report://eve/latest" : n === "ledger.jsonl" ? "ledger://ape" : n === "genesis-ledger.db" ? "ledger://genesis" : "tasks://current" }));
          result = { ref: a.ref ?? "latest", artifacts, dataDir: dir };
        }
        break;
      }
      case "ape_task_start": {
        const inner = a.tool;
        if (!TOOL_DEFS.find((t) => t.name === inner) || inner === "ape_task_start") { result = { error: "unknown_tool", name: inner }; break; }
        const id = taskCreate(inner, a.arguments ?? {});
        setImmediate(async () => {
          try {
            const r = await dispatchCall(inner, a.arguments ?? {}, { ...ctx, viaTask: id });
            taskFinish(id, r);
          } catch (e) { taskFinish(id, null, String(e).slice(0, 300)); }
        });
        result = { task_id: id, status: "running", poll: "ape_task_get" };
        break;
      }
      case "ape_task_get": result = taskGet(a.task_id); break;
      case "ape_agent_profiles": {
        result = { profiles: listProfiles().map((n) => ({ ...describeProfile(n), description: describeProfile(n)?.description })) };
        break;
      }
      case "ape_agent_run": {
        const profile = loadProfile(a.profile);
        if (!profile) { result = { error: "profile_not_found", profile: a.profile, available: listProfiles() }; break; }
        stripMockInput(a);
        // Atomic admission (ceilings + insert in one transaction — no overshoot).
        reconcileRuns();
        const admitted = admitRun({ profile: a.profile, model: profile.model.id, objective: a.objective, organism_id: a.organism_id ?? "default", outcome_family: familyOf(a.objective), profile_hash: profileHash(profile), env_hash: envFingerprint(connectorList()), maxConcurrent: Number(process.env.APE_MAX_CONCURRENT_RUNS ?? 4), dailyCapUsd: Number(process.env.APE_MAX_DAILY_USD ?? 25) });
        if (admitted.error) { result = admitted; break; }
        const runId = admitted.run_id;
        const worker = fork(join(root, "src", "agent", "worker.js"), [runId, JSON.stringify({ mockScript: a._mockScript, mockCostPerCall: a._mockCostPerCall, provider: a.provider, model: a.model })], { stdio: ["ignore", "ignore", "inherit", "ipc"], detached: true, execArgv: [] });
        worker.unref();
        updateRun(runId, { worker_pid: worker.pid });
        worker.on("exit", () => runningAgents.delete(runId));
        runningAgents.set(runId, worker);
        result = { run_id: runId, status: "running", profile: a.profile, poll: "ape_agent_status" };
        break;
      }
      case "ape_agent_status":
        reconcileRuns();
        result = getRun(a.run_id);
        break;
      case "ape_agent_cancel": {
        const run = getRun(a.run_id);
        const w = runningAgents.get(a.run_id);
        if (w) { try { w.kill(); } catch { /* already gone */ } runningAgents.delete(a.run_id); }
        else if (run.status === "running" && run.worker_pid) { try { process.kill(run.worker_pid); } catch { /* already gone */ } }
        if (run.status === "running") {
          updateRun(a.run_id, { status: "stopped", stop_reason: "cancelled", finished_at: new Date().toISOString() });
          result = { run_id: a.run_id, status: "stopped", stop_reason: "cancelled" };
        } else {
          result = { run_id: a.run_id, status: run.status, stop_reason: run.stop_reason, note: "run already finished" };
        }
        break;
      }
      case "ape_agent_resume": {
        result = resumeRun(a.run_id, { mockScript: a._mockScript, mockCostPerCall: a._mockCostPerCall, provider: a.provider, model: a.model });
        break;
      }
      case "ape_agent_analyze": {
        const { analyzeProfile, recordAnalysis } = await import("./agent/analyze.js");
        const analysis = analyzeProfile(a.profile, { window: Number(a.window ?? 20) });
        if (a.record === true && !analysis.error) {
          analysis.recorded = await recordAnalysis(a.profile, analysis, a.organism_id);
        }
        result = analysis;
        break;
      }
      case "ape_agent_family": {
        // Cost-per-outcome + variant tracking for one outcome family (or an
        // objective, which is normalized to its family automatically).
        const family = a.family ?? familyOf(a.objective ?? "");
        result = familyStats(family);
        break;
      }
      case "ape_agent_deprecate": {
        if (!a.family || !a.outcome_hash || !a.reason) { result = { error: "missing_args", need: ["family", "outcome_hash", "reason"] }; break; }
        result = deprecateVariant({ family: a.family, outcome_hash: a.outcome_hash, reason: a.reason });
        break;
      }
      case "ape_connector_list": {
        result = { connectors: connectorList().map((c) => ({ name: c.name, source: c.source, egress_allow: c.egress_allow, operations: c.operations.map((o) => ({ name: o.name, method: o.method, path: o.path, annotations: o.annotations })) })) };
        break;
      }
      case "ape_connector_call": {
        const conn = loadConnector(a.connector);
        if (!conn) { result = { error: "connector_not_found", connector: a.connector, available: connectorList().map((c) => c.name) }; break; }
        const op = conn.operations.find((o) => o.name === a.operation);
        if (!op) { result = { error: "connector_unknown_operation", connector: a.connector, operations: conn.operations.map((o) => o.name) }; break; }
        if (op.annotations?.destructive && a.confirm !== true && !ctx.headlessBypass) {
          emitTrace({ traceId, tool: name, resultSummary: "input_required:connector-confirm" });
          return { resultType: "input_required", traceId, inputRequests: [{ id: "confirm-connector", type: "elicitation", message: `Connector ${a.connector} operation ${a.operation} is destructive. Confirm?`, schema: { confirm: "boolean" } }], requestState: shaShort(traceId + name) };
        }
        result = await (await import("./connectors.js")).runConnectorOperation(conn, op, a.input ?? {}, { ...ctx, confirm: a.confirm === true });
        break;
      }
      default: result = { error: "unknown_tool", name };
    }
  } catch (e) {
    result = { error: "handler_failed", message: String(e).slice(0, 300) };
  }
  for (const m of mods) { try { if (m.hooks?.postCall) result = (await m.hooks.postCall(name, a, result, ctx)) ?? result; } catch { /* mods never break core */ } }
  // Display payload: for run status with many steps, emit a compact SUMMARY the model
  // can act on from content.text alone (hosts are not required to forward
  // structuredContent). structuredContent always carries the full record.
  const display = (name === "ape_agent_status" && Array.isArray(result?.steps) && result.steps.length > 8)
    ? runStatusSummary(result)
    : safeTruncate(result, 4000);
  const out = {
    resultType: "complete", traceId,
    content: [{ type: "text", text: JSON.stringify(display) }],
    structuredContent: { tool: name, ok: !result?.error, result },
  };
  emitTrace({ traceId, tool: name, argsHash: shaShort(JSON.stringify(args)), handles: a.organism_id ?? a.node ?? "", durationMs: Date.now() - t0, resultSummary: JSON.stringify(result).slice(0, 200), modApplied: mods.map((m) => m.name).join(",") });
  return out;
}

export function toolsList() {
  return { protocol: PROTOCOL, tools: [...TOOL_DEFS].sort((a, b) => a.name.localeCompare(b.name)), ttlMs: 60000, cacheScope: "public" };
}

const RESOURCES = [
  { uri: "genome://current", name: "genome", description: "Current ADAM genome payload", mimeType: "application/json" },
  { uri: "ledger://genesis", name: "genesis-ledger", description: "Genesis hash-chained audit ledger", mimeType: "application/json" },
  { uri: "ledger://ape", name: "ape-ledger", description: "APE run/ledger summaries", mimeType: "application/json" },
  { uri: "graph://skein/current", name: "skein-graph", description: "Current Skein task graph", mimeType: "application/json" },
  { uri: "tasks://current", name: "tasks", description: "Background task list", mimeType: "application/json" },
];
const PROMPTS = [
  { name: "ape-triage", description: "Triage an issue: recall prior decisions, verify, store the outcome", arguments: [{ name: "topic", required: true }] },
  { name: "ape-validate", description: "Run a seeded EVE validation and store the decision", arguments: [{ name: "url", required: true }] },
  { name: "ape-audit", description: "Audit a verifier with Genesis and record the verdict", arguments: [{ name: "verifier", required: true }] },
];

export function resourcesList() {
  return { resources: RESOURCES };
}
export function promptsList() {
  return { prompts: PROMPTS };
}
export async function readResource(uri) {
  if (uri === "genome://current") {
    const g = await adamCall("adam_genome", {}, "default");
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(g).slice(0, 8000) }] };
  }
  if (uri === "ledger://genesis" || uri === "ledger://ape") {
    const dir = dataDir();
    const file = uri === "ledger://genesis" ? "genesis-ledger.db" : "ledger.jsonl";
    const p = join(dir, file);
    if (!existsSync(p)) return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ present: false, hint: "no entries yet" }) }] };
    if (file.endsWith(".jsonl")) {
      const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-20);
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(lines.map((l) => { try { return JSON.parse(l); } catch { return l; } })) }] };
    }
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ present: true, path: p, note: "sqlite ledger; query via ape_report" }) }] };
  }
  if (uri === "graph://skein/current") {
    const g = await dispatch.orchestrate({ op: "graph" });
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(g).slice(0, 8000) }] };
  }
  if (uri === "tasks://current") {
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(taskList()) }] };
  }
  throw Object.assign(new Error(`resource not found: ${uri}`), { code: -32002 });
}
export async function getPrompt(name, args = {}) {
  const bodies = {
    "ape-triage": `Triage "${args.topic ?? "{topic}"}": first call ape_recall with the topic, then verify with the relevant engine tool, then ape_remember the decision. Never claim completion without evidence.`,
    "ape-validate": `Validate "${args.url ?? "{url}"}" with ape_validate_experience (always pass a seed), then ape_remember the decision with the seed and persona.`,
    "ape-audit": `Audit verifier "${args.verifier ?? "{verifier}"}" with ape_audit_claim, record the verdict, and append the ledger entry reference.`,
  };
  if (!bodies[name]) throw Object.assign(new Error(`unknown prompt: ${name}`), { code: -32602 });
  return { messages: [{ role: "user", content: { type: "text", text: bodies[name] } }] };
}
export function discover() {
  return {
    protocol: PROTOCOL,
    server: { name: "ape-mcp", version: "1.0.0" },
    // Honest wire contract (dual-era): newline-delimited JSON-RPC over stdio
    // with the legacy method set (initialize/tools/list/tools/call/...) plus
    // modern server/discover. Stateless — no session ids. This is NOT a
    // wire-complete native 2026-07-28 transport; clients must not assume
    // wire semantics beyond what is declared here.
    transport: {
      stdio: "newline-delimited JSON-RPC",
      handshake: ["initialize", "server/discover"],
      sessions: "stateless",
      wire: "legacy-shaped method set + modern discovery (dual-era)",
    },
    capabilities: {
      tools: {}, resources: {}, prompts: {},
      extensions: {
        "io.modelcontextprotocol/tasks": {},
        "dev.ape/agent": { version: "0.1" },
      },
    },
  };
}

// dev.ape/agent extension methods (also reachable as tools for extension-blind hosts).
export async function agentMethod(method, params = {}) {
  switch (method) {
    case "agent/listProfiles":
      return { profiles: listProfiles().map((n) => describeProfile(n)) };
    case "agent/describeProfile":
      return describeProfile(params.profile) ?? { error: "profile_not_found", profile: params.profile, available: listProfiles() };
    case "agent/run": {
      const profile = loadProfile(params.profile);
      if (!profile) return { error: "profile_not_found", profile: params.profile, available: listProfiles() };
      stripMockInput(params);
      reconcileRuns();
      const admitted = admitRun({ profile: params.profile, model: profile.model.id, objective: params.objective, organism_id: params.organism_id ?? "default", outcome_family: familyOf(params.objective), profile_hash: profileHash(profile), env_hash: envFingerprint(connectorList()), maxConcurrent: Number(process.env.APE_MAX_CONCURRENT_RUNS ?? 4), dailyCapUsd: Number(process.env.APE_MAX_DAILY_USD ?? 25) });
      if (admitted.error) return admitted;
      const runId = admitted.run_id;
      const worker = fork(join(root, "src", "agent", "worker.js"), [runId, JSON.stringify({ mockScript: params._mockScript, mockCostPerCall: params._mockCostPerCall, provider: params.provider, model: params.model })], { stdio: ["ignore", "ignore", "inherit", "ipc"], detached: true, execArgv: [] });
      worker.unref();
      updateRun(runId, { worker_pid: worker.pid });
      worker.on("exit", () => runningAgents.delete(runId));
      runningAgents.set(runId, worker);
      return { run_id: runId, status: "running", profile: params.profile };
    }
    case "agent/getRun":
      reconcileRuns();
      return getRun(params.run_id);
    case "agent/cancel": {
      const run = getRun(params.run_id);
      const w = runningAgents.get(params.run_id);
      if (w) { try { w.kill(); } catch { /* already gone */ } runningAgents.delete(params.run_id); }
      else if (run.status === "running" && run.worker_pid) { try { process.kill(run.worker_pid); } catch { /* already gone */ } }
      if (run.status === "running") {
        updateRun(params.run_id, { status: "stopped", stop_reason: "cancelled", finished_at: new Date().toISOString() });
        return { run_id: params.run_id, status: "stopped", stop_reason: "cancelled" };
      }
      return { run_id: params.run_id, status: run.status, stop_reason: run.stop_reason, note: "run already finished" };
    }
    case "agent/resume":
      return resumeRun(params.run_id, { mockScript: params._mockScript, mockCostPerCall: params._mockCostPerCall, provider: params.provider, model: params.model });
    default:
      return { error: "unknown_method", method };
  }
}