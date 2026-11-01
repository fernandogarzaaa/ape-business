// Postinstall: ensure vendored Node engines have their deps.
// Vendored node_modules are EXCLUDED from the npm package to keep it shippable;
// this installs them on first `npm install` (global or local). Idempotent and fast
// when deps already exist.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const v of ["vendors/genesis", "vendors/eve"]) {
  const dir = join(root, v);
  if (!existsSync(join(dir, "package.json"))) continue;
  if (existsSync(join(dir, "node_modules"))) continue;
  console.log(`postinstall: installing ${v} dependencies…`);
  try {
    execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: dir, stdio: "inherit", shell: process.platform === "win32",
    });
  } catch {
    console.error(`postinstall: ${v} install failed; run manually: npm --prefix ${v} install --ignore-scripts`);
  }
}