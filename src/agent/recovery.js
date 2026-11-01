// Recovery — failure fingerprints, repair SELECTION, and immunity memory.
//
// The old behavior consulted history and then retried the identical operation
// anyway. Now the loop asks what repair to apply: a learned action from past
// successes for this fingerprint, an escalation when history shows repeated
// failure, or the class default. Outcomes are recorded back so the next
// identical failure meets a smarter policy:
//
//   failure fingerprint → history → repair action → repaired retry → record
//
// Repair vocabulary (everything the loop can actually do):
//   retry            — identical retry (transient blips)
//   retry-delayed    — wait N ms, then retry (rate limits, cold starts)
//   retry-shrunk     — truncate long string args, then retry (oversized inputs)
//
// Best-effort throughout: ADAM unavailable means defaults, never a crash.
import { adamCall } from "../adam-client.js";

// Errors worth repairing. Permanent conditions (missing builds, unknown tools,
// policy denials, confirm gates) are never retried.
const RETRYABLE = new Set([
  "handler_failed",
  "connector_fetch_failed",
  "connector_timeout",
  "timeout",
]);

export function isRetryable(result) {
  return !!result && typeof result.error === "string" && RETRYABLE.has(result.error);
}

// Coarse fingerprint: tool + error code (not the message, so it matches across
// instances of the same failure class).
export function fingerprint(toolName, result) {
  return `${toolName}:${result?.error ?? "unknown"}`;
}

// Class defaults: what to do with no history.
export const DEFAULT_REPAIRS = {
  connector_timeout: { action: "retry-delayed", delayMs: 1500 },
  timeout: { action: "retry-delayed", delayMs: 1500 },
  connector_fetch_failed: { action: "retry" },
  handler_failed: { action: "retry" },
};
export const RETRY_SHRINK_LIMIT = 1000;

// Truncate long string args (shallow), preserving shape. Oversized inputs are
// a common handler failure mode; a shrunk retry often succeeds where an
// identical one just fails expensively again.
export function shrinkArgs(args) {
  if (!args || typeof args !== "object") return args;
  const out = Array.isArray(args) ? [...args] : { ...args };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === "string" && out[k].length > RETRY_SHRINK_LIMIT) {
      out[k] = out[k].slice(0, RETRY_SHRINK_LIMIT) + `...[truncated ${out[k].length - RETRY_SHRINK_LIMIT} chars for retry]`;
    }
  }
  return out;
}

// Parse recorded repair history into structured entries. Record format:
//   repair:<fp> repair=<action> outcome=<outcome>
// (delayMs rides in the action as retry-delayed:<ms> when non-default.)
export function parseRepairHistory(text, fp) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.includes(fp)) continue;
    const m = /repair=(\S+)\s+outcome=(\S+)/.exec(line);
    if (m) out.push({ action: m[1], outcome: m[2] });
  }
  return out;
}

function parseAction(action) {
  const m = /^retry-delayed(?::(\d+))?$/.exec(action ?? "");
  if (m) return { action: "retry-delayed", delayMs: Number(m[1] ?? 1500) };
  if (action === "retry-shrunk") return { action: "retry-shrunk" };
  return { action: "retry" };
}

// The selector: learned success wins, repeated failure escalates gently,
// otherwise the class default. Never invents an action outside the vocabulary.
export function selectRepair(fp, historyText, errorCode) {
  const history = parseRepairHistory(historyText, fp);
  const success = history.find((h) => h.outcome === "success");
  if (success) return { ...parseAction(success.action), learned: true };
  const fails = history.filter((h) => h.outcome !== "success").length;
  if (fails >= 2) {
    // History says identical retries keep failing: back off instead of
    // burning another identical attempt. (Giving up entirely is the drift
    // halt's job at trajectory level, not the retry's.)
    return { action: "retry-delayed", delayMs: 1500, learned: true, escalated: true };
  }
  return { ...(DEFAULT_REPAIRS[errorCode] ?? { action: "retry" }), learned: false };
}

export async function lookupImmunity(fingerprintStr, organismId = "default") {
  try {
    const r = await adamCall("adam_memory_query", { query: fingerprintStr, top_k: 3 }, organismId);
    if (r._adam !== "ok") return null;
    const texts = (r.result ?? []).map((c) => c?.text ?? "").join("\n");
    return texts.includes(fingerprintStr) ? texts.slice(0, 2000) : null;
  } catch { return null; }
}

export async function recordImmunity(fingerprintStr, repair, outcome, organismId = "default", confidence = 0.7) {
  try {
    await adamCall("adam_memory_store", {
      kind: "procedural",
      content: `repair:${fingerprintStr} repair=${repair} outcome=${outcome}`,
      origin: "observation",
      confidence,
    }, organismId);
  } catch { /* best-effort */ }
}
