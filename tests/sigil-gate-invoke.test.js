// Integration: the Sigil gate sits inside invokeTool, before dispatch.
// A finish tool is used as the harmless execution target: if the gate
// allows, the tool runs; if it denies, nothing runs and the audit entry
// comes back in the result.
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { internalTools, invokeTool } from "../src/agent/registry.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "demo", "fixtures", "sigil-index");

test("invokeTool runs a gated tool with a verified low-risk badge", async () => {
  const res = await invokeTool(
    { name: "finish", kind: "finish", sigilServer: "@apify/actors-mcp-server", sigilVersion: "0.17.1" },
    { summary: "done" },
    { sigilIndexDir: fixtures },
  );
  assert.equal(res.done, true);
});

test("invokeTool blocks a gated tool with a revoked critical badge", async () => {
  const res = await invokeTool(
    { name: "finish", kind: "finish", sigilServer: "fixture-server", sigilVersion: "0.1.0" },
    { summary: "should never run" },
    { sigilIndexDir: fixtures },
  );
  assert.equal(res.error, "sigil_blocked");
  assert.equal(res.sigil.decision, "deny");
  assert.equal(res.sigil.reason, "revoked");
});

test("internalTools passes sigil metadata from a profile entry through to the tool", () => {
  const tools = internalTools({
    tools: [{ builtin: "finish", sigilServer: "fixture-server", sigilVersion: "0.1.0" }],
    policy: { context: { retrieve: false } },
  });
  const finish = tools.find((t) => t.name === "finish");
  assert.equal(finish.sigilServer, "fixture-server");
  assert.equal(finish.sigilVersion, "0.1.0");
});

test("invokeTool leaves ungated tools untouched", async () => {
  const res = await invokeTool(
    { name: "finish", kind: "finish" },
    { summary: "done" },
    {},
  );
  assert.equal(res.done, true);
});
