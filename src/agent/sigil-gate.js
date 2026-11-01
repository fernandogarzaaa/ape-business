// Sigil trust gate for APE tool calls (Meta hackathon demo, APE MCP plus Sigil).
//
// The gate runs BEFORE a tool executes. It never invents a badge: the caller
// passes the MCP server name and version that the tool wraps, the gate loads
// that exact badge from a Sigil index directory, verifies its Ed25519
// signature, checks revocation, applies the risk policy, and returns a
// decision plus an audit entry. A denied call must not run.
//
// Badge format: sigil-badge/v1 (legacy mcp-trust-badge/v1 accepted).
// Signature: Ed25519 over canonical JSON of the badge without its signature
// field, where canonical JSON sorts object keys recursively with no
// whitespace. keyId must equal the first 16 hex chars of SHA-256 of the
// canonical public key. This mirrors sigil-index/scripts/validate.mjs.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BADGE_TYPES = new Set(["sigil-badge/v1", "mcp-trust-badge/v1"]);
const REVOCATION_TYPES = new Set(["sigil-revocation/v1", "mcp-trust-revocation/v1"]);
const KNOWN_RISK_LEVELS = new Set(["low", "medium", "high", "critical"]);

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Hex(data) {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

// Path segment rule, identical to sigil's publish command: lowercase,
// anything outside [a-z0-9._-] becomes "-", runs collapsed, never empty.
export function sanitizeSegment(raw) {
  const out = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return out;
}

function verifySignedObject(obj, allowedTypes, expectedKey = null) {
  if (!obj || !allowedTypes.has(obj.type)) {
    return { ok: false, reason: "not a Sigil signed object (bad type field)" };
  }
  if (
    !obj.publicKey ||
    typeof obj.publicKey !== "object" ||
    typeof obj.signature !== "string" ||
    obj.signature.length === 0
  ) {
    return { ok: false, reason: "missing public key or signature" };
  }
  // When an expected key is supplied (the project key for revocations), the
  // object must be signed by that key, not merely by any self-consistent
  // embedded key. The embedded key must match the expected key exactly.
  if (expectedKey) {
    if (obj.keyId !== expectedKey.keyId || canonicalize(obj.publicKey) !== canonicalize(expectedKey.publicKey)) {
      return {
        ok: false,
        reason: `object is not signed by the project key (expected keyId "${expectedKey.keyId}")`,
      };
    }
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: expectedKey ? expectedKey.publicKey : obj.publicKey, format: "jwk" });
  } catch (error) {
    return { ok: false, reason: `public key is invalid: ${error.message}` };
  }
  const { signature, ...unsigned } = obj;
  const expectedKeyId = sha256Hex(canonicalize(expectedKey ? expectedKey.publicKey : obj.publicKey)).slice(0, 16);
  if (obj.keyId !== expectedKeyId) {
    return {
      ok: false,
      reason: `keyId "${obj.keyId}" does not match the public key (expected "${expectedKeyId}")`,
    };
  }
  try {
    const ok = cryptoVerify(
      null,
      Buffer.from(canonicalize(unsigned), "utf8"),
      publicKey,
      Buffer.from(signature, "base64"),
    );
    if (!ok) return { ok: false, reason: "signature does not verify against the public key" };
  } catch (error) {
    return { ok: false, reason: `signature check threw: ${error.message}` };
  }
  return { ok: true, reason: "" };
}

export function verifyBadge(badge) {
  return verifySignedObject(badge, BADGE_TYPES);
}

function loadJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadBadge(indexDir, server, version) {
  if (!server || !version) return null;
  const serverSeg = sanitizeSegment(server);
  const versionSeg = sanitizeSegment(version);
  if (!serverSeg || !versionSeg) return null;
  return loadJson(join(indexDir, "badges", serverSeg, `${versionSeg}.json`));
}

export function loadRevocation(indexDir, server, version) {
  if (!server || !version) return null;
  const serverSeg = sanitizeSegment(server);
  const versionSeg = sanitizeSegment(version);
  if (!serverSeg || !versionSeg) return null;
  return loadJson(join(indexDir, "revocations", serverSeg, `${versionSeg}.json`));
}

export function loadProjectKey(indexDir) {
  if (!indexDir) return null;
  const key = loadJson(join(indexDir, "keys", "project.json"));
  if (!key || typeof key.keyId !== "string" || !key.publicKey || typeof key.publicKey !== "object") return null;
  return key;
}

const DEFAULT_POLICY = {
  blockLevels: ["high", "critical"],
};

// Check one tool call against the Sigil index. Returns { decision, audit }.
// decision.allow is false for every failure mode: unknown badge, bad
// signature, revoked badge, and blocked risk level. Nothing here executes
// the tool; the caller must honour decision.allow.
export function checkSigilGate({
  indexDir,
  tool,
  server,
  version,
  policy = DEFAULT_POLICY,
} = {}) {
  const ts = new Date().toISOString();
  const base = { ts, tool: tool ?? null, server: server ?? null, version: version ?? null };
  if (!indexDir) {
    return { decision: { allow: false, reason: "no_sigil_index_dir" }, audit: { ...base, decision: "deny", reason: "no_sigil_index_dir" } };
  }
  const badge = loadBadge(indexDir, server, version);
  if (!badge) {
    return { decision: { allow: false, reason: "unknown_badge" }, audit: { ...base, decision: "deny", reason: "unknown_badge" } };
  }
  // Hardening 1: a badge file found under a path is not proof it is the
  // requested badge. Its own server/version fields must match the request,
  // so a valid low-risk badge copied under another server/version cannot
  // pass for that server/version.
  if (badge.server !== server || badge.version !== version) {
    return {
      decision: { allow: false, reason: "badge_mismatch" },
      audit: { ...base, decision: "deny", reason: "badge_mismatch", badgeType: badge.type ?? null, badgeServer: badge.server ?? null, badgeVersion: badge.version ?? null },
    };
  }
  const sig = verifyBadge(badge);
  if (!sig.ok) {
    return {
      decision: { allow: false, reason: "invalid_signature", detail: sig.reason },
      audit: { ...base, decision: "deny", reason: "invalid_signature", detail: sig.reason, badgeType: badge.type, keyId: badge.keyId ?? null, signatureValid: false },
    };
  }
  const revocation = loadRevocation(indexDir, server, version);
  let revoked = false;
  if (revocation) {
    // Hardening 4: pin the revocation to this badge and to the project
    // key. Its server/version fields must match the request (a revocation
    // filed under one path must not revoke, or clear, another badge), and
    // it must be signed by the project key in keys/project.json, not by
    // any self-consistent embedded key. This matches upstream
    // sigil-index/scripts/validate.mjs: revocations are signed by the
    // project maintainer key, which is legitimately different from a
    // badge's own key (the pinned fixture revocation is signed by project
    // key ac22e8d7e54463b7 while its badge key is e1b39068c87ecd81).
    // A revocation file with no usable project key to pin it to is
    // unverifiable, so the call is denied rather than trusted.
    if (revocation.server !== server || revocation.version !== version) {
      return {
        decision: { allow: false, reason: "revocation_mismatch" },
        audit: { ...base, decision: "deny", reason: "revocation_mismatch", badgeType: badge.type, riskScore: badge.riskScore ?? null, riskLevel: badge.riskLevel ?? null, keyId: badge.keyId ?? null, signatureValid: true },
      };
    }
    const projectKey = loadProjectKey(indexDir);
    if (!projectKey) {
      const detail = "no usable project key in index (keys/project.json) to pin revocation to";
      return {
        decision: { allow: false, reason: "revocation_unverifiable", detail },
        audit: { ...base, decision: "deny", reason: "revocation_unverifiable", detail, badgeType: badge.type, riskScore: badge.riskScore ?? null, riskLevel: badge.riskLevel ?? null, keyId: badge.keyId ?? null, signatureValid: true },
      };
    }
    const revSig = verifySignedObject(revocation, REVOCATION_TYPES, projectKey);
    if (!revSig.ok) {
      return {
        decision: { allow: false, reason: "revocation_unverifiable", detail: revSig.reason },
        audit: { ...base, decision: "deny", reason: "revocation_unverifiable", detail: revSig.reason, badgeType: badge.type, riskScore: badge.riskScore ?? null, riskLevel: badge.riskLevel ?? null, keyId: badge.keyId ?? null, signatureValid: true },
      };
    }
    revoked = revocation.status === "revoked";
    if (revoked) {
      return {
        decision: { allow: false, reason: "revoked", detail: revocation.reason ?? null },
        audit: { ...base, decision: "deny", reason: "revoked", detail: revocation.reason ?? null, badgeType: badge.type, riskScore: badge.riskScore ?? null, riskLevel: badge.riskLevel ?? null, keyId: badge.keyId ?? null, signatureValid: true, revoked: true },
      };
    }
  }
  const blockLevels = policy.blockLevels ?? DEFAULT_POLICY.blockLevels;
  if (typeof badge.riskScore !== "number" || typeof badge.riskLevel !== "string") {
    return {
      decision: { allow: false, reason: "badge_missing_risk" },
      audit: { ...base, decision: "deny", reason: "badge_missing_risk", badgeType: badge.type, keyId: badge.keyId ?? null, signatureValid: true, revoked: false },
    };
  }
  // Hardening 3: only the four known levels are decidable. An unknown
  // level must not fall through to allow just because it is not in
  // blockLevels.
  if (!KNOWN_RISK_LEVELS.has(badge.riskLevel)) {
    return {
      decision: { allow: false, reason: "unknown_risk_level" },
      audit: { ...base, decision: "deny", reason: "unknown_risk_level", badgeType: badge.type, riskScore: badge.riskScore, riskLevel: badge.riskLevel, keyId: badge.keyId ?? null, signatureValid: true, revoked: false },
    };
  }
  if (blockLevels.includes(badge.riskLevel)) {
    return {
      decision: { allow: false, reason: `risk_level_${badge.riskLevel}` },
      audit: { ...base, decision: "deny", reason: `risk_level_${badge.riskLevel}`, badgeType: badge.type, riskScore: badge.riskScore, riskLevel: badge.riskLevel, keyId: badge.keyId ?? null, signatureValid: true, revoked: false },
    };
  }
  return {
    decision: { allow: true, reason: "allowed" },
    audit: { ...base, decision: "allow", reason: "allowed", badgeType: badge.type, riskScore: badge.riskScore, riskLevel: badge.riskLevel, keyId: badge.keyId ?? null, signatureValid: true, revoked: false },
  };
}
