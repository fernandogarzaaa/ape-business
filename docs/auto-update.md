# Auto-update setup

APE re-vendors the 5 source repos automatically. Two triggers feed
`.github/workflows/auto-update.yml` (cron 6h backstop + instant dispatch + manual):

## 1. Instant dispatch (per source repo, one-time setup)

1. Create a PAT: GitHub Settings â†’ Developer settings â†’ Tokens (classic),
   scope `repo` (or fine-grained: contents read on the source, contents+PRs write on APE).
2. Add it as secret `APE_SYNC_TOKEN` in **each** of the 5 source repos.
3. Copy `docs/notify-APE.template.yml` to `<source>/.github/workflows/notify-APE.yml`,
   replacing `REPO_NAME` with one of `genesis | eve | adam | skein`.

Pushes to a source `main` then fire `source-updated` â†’ APE syncs within minutes.

## 2. Backstop + manual

* Cron runs every 6h and catches anything dispatch missed (compare HEAD vs `vendors/manifest.yaml`).
* Manual: Actions â†’ auto-update â†’ Run workflow (`repos` csv filter, `force` flag).

## 3. What the updater does

resolve SHAs â†’ clone `--depth 1` at SHA â†’ `sync-vendors.mjs` (shared keep-lists) â†’
manifest pins â†’ rebuild genesis/eve `dist/` â†’ `check-licenses.mjs` (AGPL gate) â†’
doctor/smoke/tests â†’ **one batched PR, human merge required**.

## 4. Protect `main`

Settings â†’ Branches: require PR before merging, require `ci` + verify status checks.
Without this the bot PR flow can be bypassed.

## 5. Let the bot create PRs

The updater's final step opens a pull request. The default `GITHUB_TOKEN` is only
allowed to do that if the repo setting is enabled:
**APE â†’ Settings â†’ Actions â†’ General â†’ Workflow permissions â†’ âœ… "Allow GitHub
Actions to create and approve pull requests"**.

Alternative (no setting change): add the PAT as secret `APE_SYNC_TOKEN` in the
**APE** repo â€” the workflow uses it (`secrets.APE_SYNC_TOKEN || github.token`).

Symptom if missing: `auto-update` run fails at "Open update PR" with
`GitHub Actions is not permitted to create or approve pull requests`.
