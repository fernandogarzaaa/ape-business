// Tests for the Sigil trust gate. Fixtures are verbatim copies of real
// Sigil index files at pinned versions (see demo/fixtures/README.md).
// The gate must allow the 100/low badge, deny the 0/critical revoked
// fixture, deny an unknown badge, and deny a tampered badge whose
// signature no longer verifies.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSigilGate, verifyBadge } from "../src/agent/sigil-gate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "demo", "fixtures", "sigil-index");

test("sigil gate allows a verified 100/low badge", () => {
  const { decision, audit } = checkSigilGate({
    indexDir: fixtures,
    tool: "demo-allowed-tool",
    server: "@apify/actors-mcp-server",
    version: "0.17.1",
  });
  assert.equal(decision.allow, true);
  assert.equal(audit.decision, "allow");
  assert.equal(audit.riskScore, 100);
  assert.equal(audit.riskLevel, "low");
  assert.equal(audit.signatureValid, true);
  assert.equal(audit.revoked, false);
});

test("sigil gate denies the revoked 0/critical fixture", () => {
  const { decision, audit } = checkSigilGate({
    indexDir: fixtures,
    tool: "demo-blocked-tool",
    server: "fixture-server",
    version: "0.1.0",
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "revoked");
  assert.equal(audit.decision, "deny");
  assert.equal(audit.riskScore, 0);
  assert.equal(audit.riskLevel, "critical");
  assert.equal(audit.revoked, true);
});

test("sigil gate denies an unknown badge", () => {
  const { decision, audit } = checkSigilGate({
    indexDir: fixtures,
    tool: "demo-unknown-tool",
    server: "no-such-server",
    version: "9.9.9",
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "unknown_badge");
  assert.equal(audit.decision, "deny");
});

test("sigil gate denies a tampered badge", () => {
  const tamperedDir = join(root, "demo", "fixtures", "sigil-index-tampered");
  const src = join(fixtures, "badges", "apify-actors-mcp-server", "0.17.1.json");
  const dstDir = join(tamperedDir, "badges", "apify-actors-mcp-server");
  mkdirSync(dstDir, { recursive: true });
  const badge = JSON.parse(readFileSync(src, "utf8"));
  badge.riskScore = 100;
  badge.riskLevel = "low";
  badge.findingCounts = { critical: 99, major: 0, minor: 0, info: 0 };
  writeFileSync(join(dstDir, "0.17.1.json"), JSON.stringify(badge));
  assert.equal(verifyBadge(badge).ok, false);
  const { decision } = checkSigilGate({
    indexDir: tamperedDir,
    tool: "demo-tampered-tool",
    server: "@apify/actors-mcp-server",
    version: "0.17.1",
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "invalid_signature");
});

test("sigil gate denies a verified high-risk badge under the default policy", () => {
  const { decision, audit } = checkSigilGate({
    indexDir: fixtures,
    tool: "demo-high-tool",
    server: "@modelcontextprotocol/server-github",
    version: "2025.4.8",
  });
  assert.equal(decision.allow, false);
  assert.equal(decision.reason, "risk_level_high");
  assert.equal(audit.riskScore, 65);
  assert.equal(audit.riskLevel, "high");
  assert.equal(audit.signatureValid, true);
  assert.ok(existsSync(fixtures));
});
