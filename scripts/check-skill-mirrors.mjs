// Fail if a host-manifest skill mirror drifts from its canonical source.
// skills/ape/SKILL.md is the single source of truth; hosts that require a
// fixed path (e.g. Codex -> .codex/skills/ape/SKILL.md) get a byte-identical
// mirror. Edit the canonical file, never the mirror.
// Run: node scripts/check-skill-mirrors.mjs
import { readFileSync } from "node:fs";

const MIRRORS = [
  { canonical: "skills/ape/SKILL.md", mirror: ".codex/skills/ape/SKILL.md", host: "Codex" },
];

let failed = false;
for (const { canonical, mirror, host } of MIRRORS) {
  let a, b;
  try {
    a = readFileSync(canonical);
  } catch (e) {
    console.error(`check-skill-mirrors: cannot read canonical ${canonical}: ${e.message}`);
    failed = true;
    continue;
  }
  try {
    b = readFileSync(mirror);
  } catch (e) {
    console.error(`check-skill-mirrors: missing ${host} mirror ${mirror} (required host path): ${e.message}`);
    failed = true;
    continue;
  }
  if (!a.equals(b)) {
    console.error(
      `check-skill-mirrors: ${mirror} drifted from ${canonical} ` +
      `(${host} requires that path; copy the canonical file over it)`
    );
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`check-skill-mirrors: ${MIRRORS.length} mirror(s) in sync`);
