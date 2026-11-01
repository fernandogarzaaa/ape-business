// Supply-chain integrity helpers: checksum parse/verify (offline; the network
// fetch path itself is exercised by CI auto-update, not unit tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { sha256File, parseChecksumFile, verifyChecksum, assetFor } = await import("../scripts/fetch-adam.mjs");

test("supply: sha256 roundtrip verifies, mismatch fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "ape-supply-"));
  const f = join(dir, "bin");
  writeFileSync(f, "fake-binary-bytes");
  const hex = sha256File(f);
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(verifyChecksum(f, hex).ok, true);
  assert.equal(verifyChecksum(f, hex.toUpperCase()).ok, true, "case-insensitive");
  assert.equal(verifyChecksum(f, "0".repeat(64)).ok, false, "mismatch detected");
});

test("supply: checksum sidecar parsing (gnu + bsd styles)", () => {
  const hex = "a".repeat(64);
  assert.equal(parseChecksumFile(`${hex}  adam-mcp-linux-x64\n`, "adam-mcp-linux-x64"), hex);
  assert.equal(parseChecksumFile(`${hex} *adam-mcp-win-x64.exe\n`, "adam-mcp-win-x64.exe"), hex);
  assert.equal(parseChecksumFile(`${hex}  other-file\n`, "adam-mcp-linux-x64"), null, "wrong asset ignored");
  assert.equal(parseChecksumFile("not-a-checksum\n", "x"), null, "garbage ignored");
  assert.equal(parseChecksumFile("", "x"), null, "empty ignored");
});

test("supply: asset mapping covers the CI matrix", () => {
  assert.equal(assetFor("win32", "x64"), "adam-mcp-win-x64.exe");
  assert.equal(assetFor("darwin", "arm64"), "adam-mcp-darwin-arm64");
  assert.equal(assetFor("linux", "x64"), "adam-mcp-linux-x64");
});
