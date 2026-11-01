// Two-case Sigil gate demo. No tool executes here: the demo prints the
// gate decision and audit entry for an allowed tool and a blocked tool.
// Run: node demo/sigil-gate-demo.mjs
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSigilGate } from "../src/agent/sigil-gate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexDir = join(root, "demo", "fixtures", "sigil-index");

const cases = [
  { tool: "allowed-tool", server: "@apify/actors-mcp-server", version: "0.17.1" },
  { tool: "blocked-tool", server: "fixture-server", version: "0.1.0" },
];

for (const c of cases) {
  const { decision, audit } = checkSigilGate({ indexDir, ...c });
  console.log(`${c.tool}: ${decision.allow ? "ALLOW" : "DENY"} (${decision.reason})`);
  console.log(JSON.stringify(audit));
}
