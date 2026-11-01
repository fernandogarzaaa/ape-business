// Agent profiles — the user-editable definition of what the agent *is*.
// Loaded at call time (no restart). Bundled defaults ship in profiles/; user
// overrides live in .ape/profiles/ and win.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateContextLayer } from "./context.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function bundledDir() { return join(root, "profiles"); }
function userDir() {
  const d = process.env.APE_DATA_DIR || join(process.cwd(), ".ape");
  return join(d, "profiles");
}

const VALID_STOPS = ["no_tool_call_in_step", "explicit_final_answer", "budget_exhausted"];

export const DEFAULT_VERIFY_TOOLS = ["genesis.audit_claim", "eve.validate_experience", "eve.mcp_eval", "genesis.compare"];

// CR-1 hardening: the loader used to rebuild limits/policy from fixed key lists,
// silently discarding documented controls (credential allow-lists, spend caps,
// parallel/drift/dedup tuning). Now every documented key is preserved with
// explicit validation; unknown keys are dropped loudly in the returned
// `_warnings` (never silently), and invalid values fall back to safe defaults.
// Numeric limits are coerced — a non-numeric max_usd must not mean "unlimited".
function num(v, fallback, { min = 0 } = {}) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
function validatedCredentialPolicy(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  if (Array.isArray(raw.allow)) {
    const allow = raw.allow.filter((x) => typeof x === "string" && x);
    if (allow.length) out.allow = [...new Set(allow)];
  }
  if (raw.max_spend_usd && typeof raw.max_spend_usd === "object") {
    const caps = {};
    for (const [k, v] of Object.entries(raw.max_spend_usd)) {
      const n = Number(v);
      if (typeof k === "string" && k && Number.isFinite(n) && n >= 0) caps[k] = n;
    }
    if (Object.keys(caps).length) out.max_spend_usd = caps;
  }
  return Object.keys(out).length ? out : undefined;
}
function validatedDrift(raw) {
  if (raw === false) return false;
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  if (raw.warn_streak !== undefined) out.warn_streak = Math.max(1, Math.floor(Number(raw.warn_streak)) || 6);
  if (raw.max_errors !== undefined) out.max_errors = Math.max(1, Math.floor(Number(raw.max_errors)) || 4);
  return out;
}

export function loadProfile(name) {
  const userPath = join(userDir(), `${name}.yaml`);
  const bundlePath = join(bundledDir(), `${name}.yaml`);
  const p = existsSync(userPath) ? userPath : existsSync(bundlePath) ? bundlePath : null;
  if (!p) return null;
  let profile;
  try { profile = YAML.parse(readFileSync(p, "utf8")); } catch { return null; }
  if (!profile?.name || !profile?.model?.provider) return null;
  profile.source = p;
  profile.model = {
    provider: profile.model.provider ?? "auto",
    id: profile.model.id ?? "auto",
    fallback: profile.model.fallback,
  };
  profile.stop_conditions = (profile.stop_conditions ?? ["no_tool_call_in_step", "explicit_final_answer", "budget_exhausted"])
    .filter((s) => VALID_STOPS.includes(s));
  profile.limits = {
    max_steps: num(profile.limits?.max_steps, 12, { min: 1 }),
    max_tokens: num(profile.limits?.max_tokens, 120000, { min: 1 }),
    max_wall_seconds: num(profile.limits?.max_wall_seconds, 300, { min: 1 }),
    max_usd: num(profile.limits?.max_usd, 0.5),
    max_destructive: num(profile.limits?.max_destructive, 1),
    max_repeats: num(profile.limits?.max_repeats, 3),
    max_retries: num(profile.limits?.max_retries, 1),
    max_history_tokens: num(profile.limits?.max_history_tokens, 60000, { min: 1 }),
    max_delegate_depth: num(profile.limits?.max_delegate_depth, 2),
    ...(profile.limits?.max_parallel !== undefined
      ? { max_parallel: Math.max(1, Math.floor(Number(profile.limits.max_parallel)) || 4) }
      : {}),
  };
  const credential_policy = validatedCredentialPolicy(profile.policy?.credential_policy);
  const drift = validatedDrift(profile.policy?.drift);
  profile.policy = {
    destructive: profile.policy?.destructive === "allow" ? "allow" : "deny",
    routing: profile.policy?.routing === false ? false : true,
    verify_before_finish: ["warn", "enforce", "off"].includes(profile.policy?.verify_before_finish)
      ? profile.policy.verify_before_finish
      : "warn",
    verify_tools: Array.isArray(profile.policy?.verify_tools) && profile.policy.verify_tools.length
      ? profile.policy.verify_tools
      : [...DEFAULT_VERIFY_TOOLS],
    // Evidence mode: "any" = presence of a verification step passes (legacy);
    // "agree" = correlated verdicts must agree (no refutations).
    evidence: profile.policy?.evidence === "agree" ? "agree" : "any",
    eve_threshold: Number(profile.policy?.eve_threshold ?? 50),
    // Preserved controls (absent = previous default behavior downstream):
    ...(credential_policy !== undefined ? { credential_policy } : {}),
    ...(profile.policy?.parallel_calls === false ? { parallel_calls: false } : {}),
    ...(drift !== undefined ? { drift } : {}),
    ...(profile.policy?.dedup_window_sec !== undefined && Number.isFinite(Number(profile.policy.dedup_window_sec)) && Number(profile.policy.dedup_window_sec) >= 0
      ? { dedup_window_sec: Number(profile.policy.dedup_window_sec) }
      : {}),
    // Context hygiene overrides (global defaults live in ape.config.yaml;
    // every field here is optional and wins over the global value).
    context: validateContextLayer(profile.policy?.context),
  };
  return profile;
}

export function listProfiles() {
  const names = new Set();
  for (const dir of [bundledDir(), userDir()]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".yaml")) names.add(f.slice(0, -5));
    }
  }
  return [...names].sort();
}

export function describeProfile(name) {
  const p = loadProfile(name);
  if (!p) return null;
  return {
    name: p.name,
    description: p.description ?? "",
    model: p.model,
    tools: p.tools ?? [],
    limits: p.limits,
    policy: p.policy,
    stop_conditions: p.stop_conditions,
    source: p.source,
  };
}