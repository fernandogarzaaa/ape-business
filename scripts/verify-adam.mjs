// Boots the adam-mcp binary for this platform (vendored win-x64 exe,
// cargo-built, or Release-fetched) and verifies the MCP handshake.
// Usage: node scripts/verify-adam.mjs [--build-if-missing]
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assetFor, destFor } from "./fetch-adam.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const asset = assetFor();
if (!asset) { console.error("unsupported platform"); process.exit(1); }
let bin = destFor(asset);
async function ensure() {
  if (existsSync(bin)) return;
  if (!process.argv.includes("--build-if-missing")) {
    console.error(`missing adam binary for ${asset}; run: node scripts/fetch-adam.mjs`);
    process.exit(1);
  }
  console.log("building adam-mcp from vendors/adam …");
  execFileSync("cargo", ["build", "-p", "adam-mcp"], { cwd: "vendors/adam", stdio: "inherit" });
  const debug = process.platform === "win32"
    ? "vendors/adam/target/debug/adam-mcp.exe"
    : "vendors/adam/target/debug/adam-mcp";
  if (!existsSync(debug)) { console.error("cargo build produced no binary"); process.exit(1); }
  bin = debug;
}
await ensure();
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
const r = spawnSync(bin, [], { input: init, encoding: "utf8", timeout: 60000 });
const line = (r.stdout || "").split("\n").find(Boolean);
if (!line) { console.error("no response from adam-mcp"); process.exit(1); }
const msg = JSON.parse(line);
const tools = msg.result?.capabilities ? true : false;
const hasInstructions = typeof msg.result?.instructions === "string" && msg.result.instructions.includes("adam_");
if (!tools || !hasInstructions) { console.error("handshake missing capabilities/instructions"); process.exit(1); }
console.log(`adam ok: ${bin} (protocol ${msg.result.protocolVersion})`);
