# NOTICE — APE license split (combined distribution)

- APE code (`bin/`, `src/`, `console/`, `skills/`, `mods/`, `schemas/`): **MIT**.
- `vendors/genesis` (MIT), `vendors/eve` (MIT), `vendors/adam` (MIT), `vendors/skein` (MIT): see each `LICENSE`.
- Every engine ships vendored and commit-pinned via `vendors/manifest.yaml`. No runtime `git clone`, no `npx -y <other-repo>`.
- The only runtime network egress is user-declared connectors (`APE_*` env auth) and configured model providers for the embedded agent — both explicit, both listed by `ape-mcp doctor`.