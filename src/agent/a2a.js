// A2A bridge — lets non-MCP agents discover and use APE runs via the
// Agent-to-Agent protocol surface (agent card + JSON-RPC task methods).
// This is a compatible subset: synchronous request/response plus task polling,
// no streaming or push notifications in v1. Maps 1:1 onto the run ledger, so
// every A2A task is a fully audited APE run.
import { agentMethod } from "../server.js";
import { listProfiles, describeProfile } from "./profiles.js";
import { outcomeStatus } from "../runs.js";

export function agentCard(baseUrl) {
  const skills = listProfiles().map((n) => {
    const p = describeProfile(n) ?? {};
    return {
      id: n,
      name: p.name ?? n,
      description: p.description ?? "",
      tags: ["agent", "ape"],
      examples: [`Run the ${n} profile against an objective`],
    };
  });
  return {
    name: "ape-mcp",
    description: "APE: hybrid-native agent runtime. Send a message to start an agent run; poll the task for steps, cost, and outcome.",
    version: "1.0.0",
    url: baseUrl,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills,
  };
}

export function toTask(run) {
  if (!run || run.status === "not_found") {
    throw Object.assign(new Error(`task not found: ${run?.run_id ?? "?"}`), { code: -32002 });
  }
  // W-2: A2A state comes from OUTCOME, not lifecycle. status=done with
  // stop_reason=max_steps used to report completed — a lie to orchestrators.
  const outcome = run.outcome_status ?? outcomeStatus(run);
  const state = run.status === "running" ? "working"
    : outcome === "success" || outcome === "unverified" ? "completed"
    : outcome === "cancelled" ? "canceled"
    : "failed";
  const task = {
    id: run.run_id,
    contextId: "ctx-" + run.run_id,
    status: {
      state,
      timestamp: run.finished_at ?? run.started_at,
    },
  };
  if (run.status !== "running") {
    const text = `[outcome:${outcome} stop:${run.stop_reason ?? "?"}] ${String(run.outcome ?? "").slice(0, 3800)}`;
    task.status.message = {
      role: "agent",
      parts: [{ kind: "text", text }],
      messageId: "msg-" + run.run_id,
    };
    task.artifacts = [{
      artifactId: "art-" + run.run_id,
      name: "outcome",
      parts: [{ kind: "text", text: String(run.outcome ?? "").slice(0, 4000) }],
    }];
  }
  return task;
}

function textOf(message) {
  const parts = message?.parts ?? [];
  return parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n");
}

// A2A JSON-RPC dispatcher. Returns {result} or throws {code, message}.
export async function handleA2A(method, params = {}) {
  if (method === "message/send") {
    const text = textOf(params.message);
    if (!text.trim()) throw Object.assign(new Error("message/send needs a text part"), { code: -32602 });
    const profile = params.metadata?.profile ?? "repo-triage";
    const r = await agentMethod("agent/run", {
      profile,
      objective: text.slice(0, 4000),
      organism_id: params.metadata?.organism_id,
      provider: params.metadata?.provider,
      model: params.metadata?.model,
    });
    if (r.error) throw Object.assign(new Error(r.error), { code: -32000 });
    return toTask(await agentMethod("agent/getRun", { run_id: r.run_id }));
  }
  if (method === "tasks/get") {
    return toTask(await agentMethod("agent/getRun", { run_id: params.id }));
  }
  if (method === "tasks/cancel") {
    const c = await agentMethod("agent/cancel", { run_id: params.id });
    return toTask(await agentMethod("agent/getRun", { run_id: params.id }));
  }
  throw Object.assign(new Error(`unknown_method: ${method}`), { code: -32601 });
}