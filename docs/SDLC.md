# SDLC

How this repo ships, in one page. Read it before opening a PR.

## Branches and releases

- `main` is always releasable in the sense that CI passes on it.
  It is not a promise that a service is live.
- Work on a short-lived branch named by track and change, for
  example `stripe/webhook-verify` or `sms/opt-out`.
- One PR at a time per track. One change per PR. Small PRs,
  verified, easy to revert.
- Never push directly to `main` after the initial import. The
  initial import is the one exception, and it is recorded in
  HANDOFF.md.
- Versioning: no version is claimed in submission or sales text
  until a tag exists and its tests pass. Tags are `vX.Y.Z`,
  created only on Inan's call.

## Definition of done

A change is done only when all of these are true:
- Its tests pass locally and in CI, with raw output, not a
  paraphrase of success.
- No secret value was added. Env names only.
- No TODO or stub is left in shipped code, unless Inan granted
  that exact placeholder for that exact deliverable, and it is
  named in the PR description.
- HANDOFF.md is updated: the finished item moves to Done, the
  next item is named, and a dated Phase log entry is appended.
  History in HANDOFF.md is append-only, never rewritten.
- The PR description states what is real, what is mock, and what
  still needs an account, a key, or a spend approval.

## CI and CD

- CI runs on every push and PR to `main`: Node syntax check on
  every JavaScript file, SMS tests, Stripe tests, AWS dry run,
  and a secret scan. A PR is not done until CI is green.
- CD to GitHub Pages for the site is manual only
  (`workflow_dispatch`). Publishing the site is an owner action,
  never automatic on push.
- No deploy to AWS, Stripe live, or Twilio live happens from CI.
  Those are manual, owner-approved steps, documented in
  provisioning/DEPLOYMENT_PIPELINE.md.

## Security

- See provisioning/SECURITY.md for the full layered design.
- Report a security issue by opening an issue, not by publishing
  an exploit. Do not paste a real secret into an issue, a PR, or
  a log.
- A security fix gets a PR like any other change, plus a HANDOFF
  entry naming what was fixed and what was not yet verified.

## Environments

- Local and test: $0, no network to Stripe, Twilio, or AWS.
  Test harnesses use fake credentials and fictional numbers.
- Staging: only on Inan's call, in a test account, with test keys.
- Production: only on Inan's separate approvals for real Stripe,
  real AWS spend, and the published price. Never flip test to
  live by editing a config flag alone.
