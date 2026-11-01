// Fail if any tracked text file starts with a UTF-8 BOM. BOMs break naive
// parsers (YAML front-matter, JSON, shell shebangs) and must not come back.
// Run: node scripts/check-no-bom.mjs
import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// Extensions that are legitimately binary: never BOM-checked.
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
  ".zip", ".gz", ".tgz", ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".mp4", ".mov", ".db", ".sqlite",
]);

let files;
try {
  files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
} catch (e) {
  console.error("check-no-bom: git ls-files failed: " + (e?.message ?? e));
  process.exit(2);
}

const bad = [];
for (const f of files) {
  const lower = f.toLowerCase();
  if ([...BINARY_EXT].some((ext) => lower.endsWith(ext))) continue;
  let fd = -1;
  try {
    fd = openSync(f, "r");
    const head = Buffer.alloc(3);
    const n = readSync(fd, head, 0, 3, 0);
    if (n === 3 && head.equals(BOM)) bad.push(f);
  } catch {
    // Unreadable (deleted, submodule, ...): not our problem.
  } finally {
    if (fd !== -1) { try { closeSync(fd); } catch { /* ignore */ } }
  }
}
if (bad.length) {
  console.error("check-no-bom: BOM found in " + bad.length + " file(s):");
  for (const f of bad) console.error("  " + f);
  process.exit(1);
}
console.log("check-no-bom: no BOMs in " + files.length + " tracked files");
