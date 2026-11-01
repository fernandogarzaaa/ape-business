// Shared vendor copy rules â€” single source of truth for local vendor.mjs and CI sync-vendors.mjs.
// keep[] entries are copied verbatim; excluded dir names are never descended into.
export const VENDOR_JOBS = [
  { name: "genesis", repo: "https://github.com/fernandogarzaaa/genesis",
    keep: ["src","bin","adapters","benchmarks","templates","fixtures","examples","tests","docs","plugins","tools","package.json","package-lock.json","tsconfig.json","tsconfig.build.json","biome.json","vitest.config.ts","README.md","LICENSE",".claude-plugin"] },
  { name: "eve", repo: "https://github.com/fernandogarzaaa/experience-validation-engine",
    keep: ["src","bin","protocol","skills","docs","examples","tests","scripts","package.json","package-lock.json","tsconfig.json","tsconfig.build.json","biome.jsonc","vitest.config.ts","eve.config.example.yaml","README.md","LICENSE","ROADMAP.md","CONTRIBUTING.md","SECURITY.md",".claude",".codex",".claude-plugin"] },
  { name: "adam", repo: "https://github.com/fernandogarzaaa/ADAM",
    keep: ["crates","bin","protocol","skills","scripts","Cargo.toml","Cargo.lock","Dockerfile","README.md","ARCHITECTURE.md","DESIGN.md","ROADMAP.md","LICENSE",".claude-plugin",".mcp.json"] },
  { name: "skein", repo: "https://github.com/fernandogarzaaa/skein",
    keep: ["src","tests","docs","pyproject.toml","README.md","CHANGELOG.md",".github"] },
];

// Substrings that must never be copied (build outputs, VCS, venvs, caches).
export const EXCLUDE_PARTS = ["node_modules",".git/","/dist/","target/",".venv/","__pycache__",".pytest_cache/",".eve-output",".ape/",".egg-info"];
