# Contributing

Small, verified, honest PRs. That is the whole culture here.

## Before you start

- Read HANDOFF.md first. Pick the next item in order. Do not
  skip a gate to start a later phase.
- Read provisioning/SECURITY.md before touching auth, secrets,
  payments, SMS, or deploy code.

## How to contribute

1. Create a branch from `main`, named by track and change.
2. Make the smallest change that solves the problem. No scope
   creep in the same PR.
3. Run the tests in README.md. Paste raw output in the PR.
4. State in the PR description: what is real, what is mock, and
   what still needs an account, a key, or a spend approval.
5. Update HANDOFF.md for your phase, append-only.
6. Wait for CI green and for Inan's merge call. Do not merge
   your own PR.

## Rules that are not negotiable

- No secret values. Env names only.
- No TODOs or stubs in shipped code, unless Inan granted that
  exact placeholder and it is named in the PR.
- No claim that a layer is live until its test passes.
- No spending, no publishing, no sending under Inan's name,
  no account change, without his explicit call for that action.
- Commit authorship: Fernando Garza, noreply address. Never an
  agent persona name on a public commit.
