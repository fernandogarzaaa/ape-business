// Fetch prebuilt adam-mcp for this platform from the APE GitHub release.
// Standalone guarantee holds: release binaries are built from vendors/adam (same repo),
// never from the 5 source repos. Fallback: `cargo build --release -p adam-mcp` in vendors/adam.
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = process.env.APE_ADAM_TAG || "v1.0.0";

export function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return "adam-mcp-win-x64.exe";
  if (platform === "darwin" && arch === "arm64") return "adam-mcp-darwin-arm64";
  if (platform === "linux" && arch === "x64") return "adam-mcp-linux-x64";
  return null;
}
export function destFor(asset) {
  return join(root, "vendors", "adam", "target", "release",
    asset.endsWith(".exe") ? "adam-mcp.exe" : "adam-mcp");
}

// Supply-chain integrity: the binary is a trusted local runtime component, so
// it is never installed unverified when an expectation exists. Expectation
// sources (first wins): APE_ADAM_SHA256 pin, then the release's <asset>.sha256
// sidecar. Mismatch deletes the file and fails closed.
export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function parseChecksumFile(text, asset) {
  for (const line of String(text ?? "").split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && basename(m[2].trim()) === asset) return m[1].toLowerCase();
  }
  return null;
}
export function verifyChecksum(path, expectedHex) {
  const actual = sha256File(path);
  return { ok: actual.toLowerCase() === String(expectedHex ?? "").trim().toLowerCase(), actual };
}

const invokedDirectly = String(process.argv[1] || "").replace(/\\/g, "/").endsWith("scripts/fetch-adam.mjs");
if (invokedDirectly) {
  const asset = assetFor();
  const dest = asset ? destFor(asset) : null;
  if (process.argv.includes("--check")) {
    console.log(JSON.stringify({
      platform: process.platform, arch: process.arch, tag: TAG,
      asset, present: !!(dest && existsSync(dest)),
      fallback: "cd vendors/adam && cargo build --release -p adam-mcp",
    }, null, 2));
    process.exit(asset ? 0 : 1);
  }
  if (!asset) { console.error("unsupported platform for prebuilt adam-mcp; build from vendors/adam"); process.exit(1); }
  if (existsSync(dest) && !process.argv.includes("--force")) { console.log("present: " + dest); process.exit(0); }
  const url = `https://github.com/fernandogarzaaa/ape-mcp/releases/download/${TAG}/${asset}`;
  mkdirSync(dirname(dest), { recursive: true });
  console.log("fetching " + url);
  try {
    execFileSync("curl", ["-fsSL", "-o", dest, url], { stdio: "inherit" });
    if (process.platform !== "win32") execFileSync("chmod", ["+x", dest]);
    let expected = (process.env.APE_ADAM_SHA256 || "").trim() || null;
    let sidecarTried = false;
    if (!expected) {
      // Best-effort sidecar: releases SHOULD publish <asset>.sha256 next to the binary.
      try {
        const out = execFileSync("curl", ["-fsSL", "--max-time", "30", url + ".sha256"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        sidecarTried = true;
        expected = parseChecksumFile(out, asset);
        if (!expected) console.warn("checksum sidecar present but has no entry for " + asset);
      } catch { /* sidecar absent — handled below */ }
    }
    if (expected) {
      const v = verifyChecksum(dest, expected);
      if (!v.ok) {
        try { unlinkSync(dest); } catch { /* ignore */ }
        console.error(`checksum MISMATCH for ${asset}: expected ${expected}, got ${v.actual}; deleted. Refusing to install.`);
        process.exit(1);
      }
      console.log(`checksum ok (${process.env.APE_ADAM_SHA256 ? "pin" : "sidecar"}): sha256:${v.actual.slice(0, 16)}...`);
    } else if (process.env.APE_ADAM_REQUIRE_CHECKSUM === "1") {
      try { unlinkSync(dest); } catch { /* ignore */ }
      console.error("no checksum available and APE_ADAM_REQUIRE_CHECKSUM=1; deleted. Refusing to install.");
      process.exit(1);
    } else {
      console.warn(`WARNING: no checksum sidecar${sidecarTried ? "" : " (unreachable)"} and no APE_ADAM_SHA256 pin — installed WITHOUT integrity verification. Set APE_ADAM_REQUIRE_CHECKSUM=1 to fail closed instead.`);
    }
    console.log("installed: " + dest);
  } catch {
    console.error(`fetch failed (release ${TAG} may not have binaries yet); fallback: cd vendors/adam && cargo build --release -p adam-mcp`);
    process.exit(1);
  }
}