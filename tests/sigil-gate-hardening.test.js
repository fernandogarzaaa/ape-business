// Hardening tests, one per item in the Sigil gate hardening lane.
// Fixtures are either the pinned demo fixtures or freshly generated
// Ed25519-signed badges, so an unknown risk level or a forged revocation
// can be tested with a signature that actually verifies.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, checkSigilGate } from "../src/agent/sigil-gate.js";
import { invokeTool } from "../src/agent/registry.js";
import { runAgent } from "../src/agent/loop.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "demo", "fixtures", "sigil-index");

function keyIdFor(publicKey) {
  return createHash("sha256").update(canonicalize(publicKey), "utf8").digest("hex").slice(0, 16);
}

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKey.export({ format: "jwk" }) };
}

function signObject(unsigned, key) {
  const withKey = { ...unsigned, keyId: keyIdFor(key.publicKey), publicKey: key.publicKey };
  const signature = sign(null, Buffer.from(canonicalize(withKey), "utf8"), key.privateKey).toString("base64");
  return { ...withKey, signature };
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
}

function tempIndex() {
  return mkdtempSync(join(tmpdir(), "sigil-hardening-"));
}

function signedBadge({ key, server, version, riskScore, riskLevel }) {
  return signObject(
    { type: "sigil-badge/v1", server, version, riskScore, riskLevel },
    key,
  );
}

function signedRevocation({ key, server, version, status = "revoked" }) {
  return signObject(
    { type: "sigil-revocation/v1", server, version, status, reason: "test revocation", revokedAt: "2026-10-31T00:00:00.000Z" },
    key,
  );
}

// 1. Badge server/version must match the request.
test("hardening 1: a badge copied under another server or version is denied as badge_mismatch", () => {
  const dir = tempIndex();
  const badge = JSON.parse(readFileSync(join(fixtures, "badges", "apify-actors-mcp-server", "0.17.1.json"), "utf8"));
  writeJson(join(dir, "badges", "other-server", "0.17.1.json"), badge);
  writeJson(join(dir, "badges", "apify-actors-mcp-server", "9.9.9.json"), badge);
  const serverMismatch = checkSigilGate({ indexDir: dir, tool: "t", server: "other-server", version: "0.17.1" });
  assert.equal(serverMismatch.decision.allow, false);
  assert.equal(serverMismatch.decision.reason, "badge_mismatch");
  const versionMismatch = checkSigilGate({ indexDir: dir, tool: "t", server: "@apify/actors-mcp-server", version: "9.9.9" });
  assert.equal(versionMismatch.decision.allow, false);
  assert.equal(versionMismatch.decision.reason, "badge_mismatch");
});

// 2. The version segment used to load a badge file is sanitized.
test("hardening 2: a version containing a path escape cannot load a badge outside the index", () => {
  const dir = tempIndex();
  const badge = JSON.parse(readFileSync(join(fixtures, "badges", "apify-actors-mcp-server", "0.17.1.json"), "utf8"));
  // What an unsanitized `${version}.json` lookup would reach from
  // badges/apify-actors-mcp-server/: the index root's outside.json.
  const escaped = { ...badge, version: "../../outside" };
  writeJson(join(dir, "outside.json"), escaped);
  const res = checkSigilGate({ indexDir: dir, tool: "t", server: "@apify/actors-mcp-server", version: "../../outside" });
  assert.equal(res.decision.allow, false);
  assert.equal(res.decision.reason, "unknown_badge");
  // A sanitized alias that does resolve to a real badge is still caught
  // by the mismatch check, because the requested version differs.
  const alias = checkSigilGate({ indexDir: fixtures, tool: "t", server: "@apify/actors-mcp-server", version: "../0.17.1" });
  assert.equal(alias.decision.allow, false);
  assert.equal(alias.decision.reason, "badge_mismatch");
});

// 3. Risk levels outside low, medium, high, critical are rejected.
test("hardening 3: a verified badge with an unknown risk level is denied, not allowed", () => {
  const dir = tempIndex();
  const key = makeKey();
  const badge = signedBadge({ key, server: "test-server", version: "1.0.0", riskScore: 100, riskLevel: "extreme" });
  writeJson(join(dir, "badges", "test-server", "1.0.0.json"), badge);
  const res = checkSigilGate({ indexDir: dir, tool: "t", server: "test-server", version: "1.0.0" });
  assert.equal(res.decision.allow, false);
  assert.equal(res.decision.reason, "unknown_risk_level");
});

// 4. Revocation checks are pinned to the badge and the project key.
test("hardening 4: a revocation signed by a throwaway key is unverifiable, not a block or an allow", () => {
  const dir = tempIndex();
  const badgeKey = makeKey();
  const projectKey = makeKey();
  const throwawayKey = makeKey();
  writeJson(join(dir, "badges", "test-server", "1.0.0.json"), signedBadge({ key: badgeKey, server: "test-server", version: "1.0.0", riskScore: 100, riskLevel: "low" }));
  writeJson(join(dir, "keys", "project.json"), { keyId: keyIdFor(projectKey.publicKey), publicKey: projectKey.publicKey });
  writeJson(join(dir, "revocations", "test-server", "1.0.0.json"), signedRevocation({ key: throwawayKey, server: "test-server", version: "1.0.0" }));
  const res = checkSigilGate({ indexDir: dir, tool: "t", server: "test-server", version: "1.0.0" });
  assert.equal(res.decision.allow, false);
  assert.equal(res.decision.reason, "revocation_unverifiable");
});

test("hardening 4: a revocation signed by the project key blocks, even though the badge key differs", () => {
  const dir = tempIndex();
  const badgeKey = makeKey();
  const projectKey = makeKey();
  writeJson(join(dir, "badges", "test-server", "1.0.0.json"), signedBadge({ key: badgeKey, server: "test-server", version: "1.0.0", riskScore: 100, riskLevel: "low" }));
  writeJson(join(dir, "keys", "project.json"), { keyId: keyIdFor(projectKey.publicKey), publicKey: projectKey.publicKey });
  writeJson(join(dir, "revocations", "test-server", "1.0.0.json"), signedRevocation({ key: projectKey, server: "test-server", version: "1.0.0" }));
  const res = checkSigilGate({ indexDir: dir, tool: "t", server: "test-server", version: "1.0.0" });
  assert.equal(res.decision.allow, false);
  assert.equal(res.decision.reason, "revoked");
});

test("hardening 4: a revocation whose fields do not match the badge is denied as revocation_mismatch", () => {
  const dir = tempIndex();
  const badgeKey = makeKey();
  const projectKey = makeKey();
  writeJson(join(dir, "badges", "test-server", "1.0.0.json"), signedBadge({ key: badgeKey, server: "test-server", version: "1.0.0", riskScore: 100, riskLevel: "low" }));
  writeJson(join(dir, "keys", "project.json"), { keyId: keyIdFor(projectKey.publicKey), publicKey: projectKey.publicKey });
  writeJson(join(dir, "revocations", "test-server", "1.0.0.json"), signedRevocation({ key: projectKey, server: "other-server", version: "1.0.0" }));
  const res = checkSigilGate({ indexDir: dir, tool: "t", server: "test-server", version: "1.0.0" });
  assert.equal(res.decision.allow, false);
  assert.equal(res.decision.reason, "revocation_mismatch");
});

test("hardening 4: a revocation with no project key in the index is unverifiable", () => {
  const dir = tempIndex();
  const badgeKey = makeKey();
  const projectKey = makeKey();
  writeJson(join(dir, "badges", "test-server", "1.0.0.json"), signedBadge({ key: badgeKey, server: "test-server", version: "1.0.0", riskScore: 100, riskLevel: "low" }));
  writeJson(join(dir, "revocations", "test-server", "1.0.0.json"), signedRevocation({ key: projectKey, server: "test-server", version: "1.0.0" }));
  const res = checkSigilGate({ indexDir: dir, tool: "t", server: "test-server", version: "1.0.0" });
  assert.equal(res.decision.allow, false);
  assert.equal(res.decision.reason, "revocation_unverifiable");
});

// 5. An allowed gated call attaches and emits its audit entry.
test("hardening 5: invokeTool attaches the audit entry on allow and emits it to the trace", async () => {
  const dataDir = tempIndex();
  const prevDataDir = process.env.APE_DATA_DIR;
  process.env.APE_DATA_DIR = dataDir;
  try {
    const res = await invokeTool(
      { name: "finish", kind: "finish", sigilServer: "@apify/actors-mcp-server", sigilVersion: "0.17.1" },
      { summary: "done" },
      { sigilIndexDir: fixtures },
    );
    assert.equal(res.done, true);
    assert.equal(res.sigil.decision, "allow");
    assert.equal(res.sigil.riskLevel, "low");
    const tracePath = join(dataDir, "trace.ndjson");
    assert.ok(existsSync(tracePath), "trace file was written");
    const entries = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const sigilEntry = entries.find((e) => e.tool === "agent.sigil" && e.sigil?.decision === "allow");
    assert.ok(sigilEntry, "an allow audit entry was emitted to the trace");
    assert.equal(sigilEntry.sigil.riskLevel, "low");
  } finally {
    if (prevDataDir === undefined) delete process.env.APE_DATA_DIR;
    else process.env.APE_DATA_DIR = prevDataDir;
  }
});

// 6. The Sigil index directory is threaded through the delegate context.
test("hardening 6: a loop run with an explicit sigilIndexDir does not depend on SIGIL_INDEX_DIR", async () => {
  const dataDir = tempIndex();
  const prevDataDir = process.env.APE_DATA_DIR;
  const prevIndexDir = process.env.SIGIL_INDEX_DIR;
  process.env.APE_DATA_DIR = dataDir;
  process.env.SIGIL_INDEX_DIR = "/nonexistent-sigil-index-dir-for-test";
  try {
    const profile = {
      name: "sigil-loop",
      model: { provider: "mock", id: "mock-model" },
      system: "You are a careful agent. Call finish exactly once with the summary you are given, and nothing else.",
      tools: [{ builtin: "finish", sigilServer: "@apify/actors-mcp-server", sigilVersion: "0.17.1" }],
      limits: { max_steps: 4, max_tokens: 60000, max_wall_seconds: 60, max_usd: 1.0 },
      stop_conditions: ["no_tool_call_in_step", "explicit_final_answer", "budget_exhausted"],
      policy: { verify_tools: [], context: { retrieve: false } },
    };
    const res = await runAgent({
      profile,
      objective: "Call finish with summary exactly: loop sigil test",
      mockScript: [{ tool: "finish", args: { summary: "loop sigil test" } }],
      sigilIndexDir: fixtures,
    });
    assert.equal(res.stop_reason, "explicit_final_answer");
    // The loop's grounding gate appends an unverified note in warn mode
    // (no verification tool ran); the finish summary itself must lead.
    assert.ok(String(res.outcome).startsWith("loop sigil test"));
    const finishSteps = (res.steps ?? []).filter((s) => s.kind === "tool" && s.tool === "finish");
    assert.ok(finishSteps.length >= 1, "a finish step was recorded");
    assert.ok(!finishSteps.some((s) => String(s.resultSummary ?? "").includes("sigil_blocked")), "finish was not Sigil-blocked");
  } finally {
    if (prevDataDir === undefined) delete process.env.APE_DATA_DIR;
    else process.env.APE_DATA_DIR = prevDataDir;
    if (prevIndexDir === undefined) delete process.env.SIGIL_INDEX_DIR;
    else process.env.SIGIL_INDEX_DIR = prevIndexDir;
  }
});
