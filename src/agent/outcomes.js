// Outcome identity — stable IDs for what runs produce, so the ledger can answer
// "have we solved this before, what did it cost, and which variants are dead."
// family: hash of the NORMALIZED objective (reruns of the same task cluster).
// variant: the run receipt's outcome_hash (what actually happened this time).
// Comparability (for safe dedup): profile_hash + env_hash + resolved model must
// match, and the prior run must have been a VERIFIED success. Anything less
// fails closed (no reuse). Pure functions; storage lives in runs.js.
import { createHash } from "node:crypto";
import { shaShort } from "../trace.js";

// SHA-256 for provenance-grade hashes; truncated only for display/column use.
export function sha256hex(s) {
  return createHash("sha256").update(String(s ?? ""), "utf8").digest("hex");
}

function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",")}}`;
}

// Canonical profile hash: ANY change to model/tools/limits/policy invalidates
// dedup reuse. Deliberately conservative — a stale profile must never inherit
// a prior run's result.
export function profileHash(profile) {
  return "ph-" + sha256hex(stableStringify(profile)).slice(0, 32);
}

// Environment fingerprint: the connector surface (names, base URLs, operation
// names). External mutable state cannot be fingerprinted cheaply — the freshness
// window bounds that residual risk, documented at the dedup call site.
export function envFingerprint(connectors) {
  const snap = (connectors ?? []).map((c) => ({
    name: c.name,
    base_url: c.base_url,
    ops: ((c.operations ?? []).map((o) => o.name)).sort(),
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return "env-" + sha256hex(stableStringify(snap)).slice(0, 32);
}

export function normalizeObjective(objective) {
  return String(objective ?? "")
    .toLowerCase()
    .replace(/run[-_ ]?id[:\s]+run-[a-z0-9-]+/g, "") // strip run ids pasted into follow-ups
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

export function familyOf(objective) {
  // SHA-256 identity (32 hex chars shown; full digest recoverable by re-hash).
  // NOTE: families created before this migration used 8-hex rolling hashes and
  // will not group with new IDs — dedup only ever matches same-era values.
  return "fam-" + sha256hex(normalizeObjective(objective)).slice(0, 32);
}
