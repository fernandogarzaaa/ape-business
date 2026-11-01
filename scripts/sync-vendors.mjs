// Re-vendor changed sources at pinned SHAs (used by CI auto-update; also runnable locally).
// Usage: node scripts/sync-vendors.mjs --src-<name> <dir> --sha-<name> <sha> [--only a,b]
//    or: node scripts/sync-vendors.mjs --check   (prints current pins)
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VENDOR_JOBS, EXCLUDE_PARTS } from "./vendor-config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

function readPins() {
  const txt = readFileSync(join(root, "vendors", "manifest.yaml"), "utf8");
  const pins = {};
  for (const m of txt.matchAll(/^  (\S+):\n(?:.*\n)*?    pin: (\S+)/gm)) pins[m[1]] = m[2];
  return pins;
}
if (args.includes("--check")) { console.log(JSON.stringify(readPins(), null, 2)); process.exit(0); }

const only = (opt("--only") || "").split(",").map((s) => s.trim()).filter(Boolean);
const report = { jobs: [] };
for (const j of VENDOR_JOBS) {
  if (only.length && !only.includes(j.name)) continue;
  const src = opt("--src-" + j.name);
  const sha = opt("--sha-" + j.name);
  if (!src) { report.jobs.push({ dest: "vendors/" + j.name, status: "skipped-no-src" }); continue; }
  if (!existsSync(src)) { report.jobs.push({ dest: "vendors/" + j.name, status: "missing-src" }); continue; }
  const dest = join(root, "vendors", j.name);
  const copied = [];
  for (const k of j.keep) {
    const s = join(src, k), d = join(dest, k);
    if (!existsSync(s)) continue;
    if (EXCLUDE_PARTS.some((p) => s.includes(p))) continue;
    try {
      rmSync(d, { recursive: true, force: true });
      cpSync(s, d, { recursive: true, force: true,
        filter: (p) => !EXCLUDE_PARTS.some((x) => p.includes(x)) });
      copied.push(k);
    } catch (e) { report.jobs.push({ dest: "vendors/" + j.name, keep: k, status: "error: " + String(e).slice(0, 120) }); }
  }
  // Keep npm-packaging hygiene inside vendored trees (re-created on every sync):
  // node_modules and python caches are installed/produced locally, never shipped.
  try {
    if (["genesis", "eve"].includes(j.name)) writeFileSync(join(dest, ".npmignore"), "node_modules\n");
    if (j.name === "skein") writeFileSync(join(dest, ".npmignore"), "__pycache__\n*.pyc\n");
  } catch { /* best-effort */ }
  report.jobs.push({ dest: "vendors/" + j.name, status: "ok", copied, sha: sha || undefined });
}
writeFileSync(join(root, "vendors", "vendor-report.json"), JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2));
console.log(JSON.stringify(report, null, 2));
const failed = report.jobs.some((j) => j.status.startsWith("error") || j.status === "missing-src");
process.exit(failed ? 1 : 0);
