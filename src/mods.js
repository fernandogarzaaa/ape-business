import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function readYamlList(path) {
  try {
    const txt = readFileSync(path, "utf8");
    const m = txt.match(/mods:\s*\[(.*?)\]/s);
    if (!m) return null;
    return m[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
  } catch { return null; }
}

// Loads mod manifests + dynamically imports each mod's hooks.js so preCall/postCall
// are REAL functions. A missing/broken hook file logs and skips — mods never break core.
export async function loadMods(root) {
  const mods = [];
  const cfgMods = readYamlList(join(root, "ape.config.yaml")) ?? readYamlList(join(root, "ape.config.example.yaml")) ?? [];
  const dirs = new Set([...cfgMods.map((m) => join(root, m.replace(/^\.\//, ""))), join(root, "mods", "policy-gates")]);
  for (const d of dirs) {
    const manifest = join(d, "mod.json");
    const hooksPath = join(d, "hooks.js");
    if (!existsSync(manifest)) continue;
    try {
      const meta = JSON.parse(readFileSync(manifest, "utf8").replace(/^\uFEFF/, ""));
      if (meta.enabled === false) continue;
      let hooks = {};
      if (existsSync(hooksPath)) {
        try {
          const m = await import(pathToFileURL(hooksPath).href);
          hooks = { preCall: m.preCall, postCall: m.postCall };
        } catch { /* broken hook file skipped with warning, never crash */ }
      }
      mods.push({ name: meta.name ?? d.split(/[/\\]/).pop(), ...meta, hooks });
    } catch { /* broken mod files skipped with warning, never crash */ }
  }
  return mods;
}