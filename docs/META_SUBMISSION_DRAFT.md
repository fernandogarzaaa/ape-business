# Meta Hackathon Submission Draft (unsubmitted, verified claims only)

Do not submit this text until Inan gives an explicit go-ahead, and
do not add a claim that is not verified by a test or a live run
in this repo or in the Meta demo copy.

Deadline: Nov 5, 2026, 10:00 AM Manila. Team name: 0xInan.
Track and problem statement: undecided, Inan's call.
Public repo for the demo copy: undecided, Inan's call. This repo,
fernandogarzaaa/ape-business, is the business platform repo, not
automatically the demo repo.

## Product, in one paragraph

APE for Business gives each business its own APE agent, with a
name, a phone number, and an email address. Customers text or
email the agent. Every tool call the agent makes is checked
against a Sigil badge before it runs. Trusted tools run.
Untrusted tools are blocked. Both outcomes go to the audit trail.

## Claims that are verified today

- Sigil gate is wired into the APE loop in the Meta demo copy,
  before dispatch, fail-closed. Tests: 13 gate and provider tests
  pass, plus 184 original suite tests, in two runs.
- Allow case: @apify/actors-mcp-server 0.17.1, 100/low, allowed.
  Policy case: @modelcontextprotocol/server-github 2025.4.8,
  65/high, verified but denied under the proposed policy.
  Block case: fixture-server 0.1.0, 0/critical, revoked, labelled
  as a Sigil test fixture, not a real server.
- Muse Wonder 1.0 live call verified via the Meta Model API:
  content "ok", finish stop, 79 tokens total. That proves the
  key and billing path work. It does not prove $150 credits
  landed. Wonder-in-loop is now also verified in the demo copy:
  allow case finished with "wonder loop test", block case recorded
  two sigil_blocked:revoked steps and the blocked tool never ran.
  The demo copy itself is still local, not a public repo.
- Stripe, SMS, and AWS deploy paths in this repo are test mode
  and dry run only, with tests passing. No real charge, no real
  AWS resource, no real SMS sent. Do not claim otherwise.

## Claims that are NOT verified, and must not appear in submission text

- Gate threshold confirmation. Proposed policy is block high,
  critical, unknown, bad signature, revoked, allow low and medium.
  Inan has not explicitly confirmed it.
- Real Stripe, real EC2, real SMS. Code paths exist in test mode.
  Live mode is not proven.
- PII never leaves a business. Sealbox is wired into SMS and
  email intake in test mode, with the token map in memory, not
  in a production vault. That is not the same claim.
- A badge proves competence. A badge proves identity, version,
  and risk level only.

## Submission checklist

- [ ] Gate threshold confirmed by Inan
- [ ] Problem statement chosen by Inan
- [ ] Public GitHub repo chosen by Inan
- [x] Wonder call inside the agent loop, tested (allow and block,
      demo copy local)
- [ ] 3-minute demo video, showing onboarding, identity, trust
      gate allow and block, and a ledger receipt
- [ ] Project description, from verified claims only
- [ ] Meta product fields, filled by Inan or on his approval
- [ ] Submit, only on Inan's explicit go-ahead
