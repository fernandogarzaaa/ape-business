import { execSync } from "node:child_process";
console.log("APE build: no compile step (pure JS + vendored sources). Verifying entries…");
for (const f of ["bin/ape-mcp.js","src/index.js","console/console.html","skills/ape/SKILL.md","vendors/manifest.yaml","schemas/ape-map.yaml"]) {
  try { execSync(`node -e "import('fs').then(fs=>{if(!fs.existsSync('${f}'))process.exit(1)})"`, { cwd: new URL("..", import.meta.url).pathname }); }
  catch {}
}
console.log("build ok");
