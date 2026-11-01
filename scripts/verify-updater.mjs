// Local verification for the auto-update pipeline (not run in CI).
// Usage: node scripts/verify-updater.mjs
import { readFileSync } from "node:fs";
import yaml from "yaml";

for (const f of [".github/workflows/ci.yml", ".github/workflows/auto-update.yml",
  ".github/workflows/adam-binaries.yml", ".github/dependabot.yml", "docs/notify-APE.template.yml"]) {
  const raw = readFileSync(f, "utf8").replace(/\$\{\{.*?\}\}/g, "EXPR");
  yaml.parse(raw);
  console.log("yaml ok:", f);
}
// Manifest pin-update regex (same shape as auto-update.yml uses).
{
  const txt = readFileSync("vendors/manifest.yaml", "utf8");
  const shas = { skein: "abc123def456" };
  let out = txt;
  for (const n of Object.keys(shas)) {
    const re = new RegExp("(  " + n + ":\n(?:.*\n)*?    pin: )\\S+");
    if (!re.test(out)) throw new Error("no match for " + n);
    out = out.replace(re, "$1" + shas[n]);
  }
  const m = out.match(/  skein:\n(?:.*\n)*?    pin: (\S+)/);
  if (m[1] !== "abc123def456") throw new Error("pin rewrite failed");
  console.log("pin-regex ok:", m[1]);
}
