# HANDOFF

Read this file first. It is the single pickup point for any agent,
including a new agent that has never seen this project. Do not start
work from a chat summary alone. Start here, then read the files this
file points to.

Last updated: 2026-10-31, Phase 0 to Phase 1 transition.
Owner: Fernando Garza (Inan). Repo: fernandogarzaaa/ape-business,
public, main branch.

## Goal definition: what complete means

Complete means the product is ready for BOTH the Meta hackathon
AND as a real product. Not one or the other. A demo that cannot
become a real product is not complete. A real product that cannot
be submitted by Nov 5 is not complete for this goal.

Hackathon ready means: public repo, 3-minute demo video, project
description, and every claim in submission text verified by a test
or a live run in this repo.
Real product ready means: onboarding, trust gate, identity by text
and email, provisioning, payments, and deploy all work end to end
in test mode, and the path to live mode is code, not a promise.
Live mode itself still needs Inan's separate approvals for each
spend, key, and account, and $0 is spent until then.

## Auto-merge rule for this repo loop (Inan, 2026-10-31)

Inan authorized auto-merge for this repo loop. A PR in
fernandogarzaaa/ape-business may be merged by the loop, without a
per-PR ask, only when all of these are true: CI is green, the
change was audited as the change it claims to be, no secret value
was added, and no spend, publish, send, or account change is
included. PRs Inan recently pushed himself are never auto-merged.
Sends under his name, spending, deletions, and account changes
remain his explicit call, even under auto-merge.

## One sentence

APE for Business gives each business its own APE agent, with a name,
a phone number, and an email address, trust-gated by Sigil on every
tool call, provisioned pay to ready, and billed cost-plus.

## Hard rules, do not break them

- Spend $0 unless Inan approves a specific charge in chat, naming
  the service and the amount. A brainstorm tap is a direction, not
  a spend approval. Test mode and dry run are the default.
- Secrets are env names only. Never put a key, token, or secret
  value in chat, code, files, or memory. Real keys go through
  Secure Vault only.
- Never claim a layer is live until its test passes and its output
  is in this repo. Mocks are a showcasing layer only. A mock must
  never be presented as a real charge, a real deploy, or a real
  message.
- Never claim PII never leaves a business, Sealbox is shipped, or a
  badge proves competence. Those three claims are false or unproven
  on current evidence. See provisioning/SECURITY.md.
- Never merge, publish, send under Inan's name, or change an
  account without his explicit call for that exact action.
- Git identity for commits in this repo: Fernando Garza, with a
  noreply address. Never let an agent persona name become a commit
  author on a public repo.

## Current status, by track (2026-10-31)

Done, tested locally, $0 spent:
- Onboarding site: 6 steps, business, connectors, budget,
  deployment, agent identity (Step 5), and bundle generation.
  File: site/index.html. JS syntax checked.
- Provisioning backend prototype: tenant, connect, provision,
  discover, pricing calculator. File: provisioning/server.js.
- Pipeline prototype: checkout to ready in 5 steps, idempotent on
  payment intent. File: provisioning/pipeline.js.
- Stripe, test mode: signature verification, Checkout from the
  calculator ($40.28 for 100 jobs = 4028 cents), amount guard,
  idempotent webhook, raw-body server wired to the pipeline.
  Tests: 12 checks pass. Files: provisioning/stripe/.
- SMS, test mode: Twilio signature verification, tenant mapping,
  STOP and START opt-out, rate limit 10 per 60 seconds, duplicate
  idempotency, first-message AI disclosure, job ledger shape.
  Tests: 10 checks pass. Files: provisioning/sms/.
- AWS deploy, code and dry run only: ECS Fargate chosen over EC2,
  prebuilt image, one IAM role per tenant, Caddy sidecar, health
  check, rollback in reverse order. Dry run: 10 checks pass.
  Files: provisioning/aws/.
- Security design: layered doc, Sealbox as Day 1 integration, not
  a later phase. File: provisioning/SECURITY.md.
- Pricing: cost-plus, $19 base plus usage times 1.40. Examples:
  100 jobs $40.28, 1,000 jobs $181.40, 5,000 jobs $808.60.
  Rates are editable estimates. Verify AWS and model rates before
  publishing any price. File: provisioning/PRICING.md.
- Product decisions log: provisioning/PRODUCT_BRAINSTORM.md.

Not done, in order:
1. Meta hackathon submission, deadline Nov 5, 2026, 10:00 AM Manila.
   Scope changed 2026-10-31: full product v1, not demo alone.
   Still open: gate threshold confirmation, problem statement
   choice, public repo for the demo copy (this repo is the
   business platform repo, not the Meta demo copy), 3-minute video, submission text.
   The Meta demo copy lives separately at
   ~/workspace/ape-mcp-sigil-demo, with Sigil gate and Wonder
   provider wiring. Do not conflate the two repos in submission
   text without checking which one a claim belongs to.
2. Phase 1 real onboarding: real Shopify OAuth first, then Gmail;
   encrypted per-tenant vault; prebuilt APE image built on a
   docker machine (docker is absent in the sandbox, build-image
   correctly refuses); github.io wired to the EC2 API; Stripe
   test-mode keys via Secure Vault; SMS test number and inbound
   email test inbox.
3. Private beta: 10 to 12 tenants total, sequenced Shopify, then
   consultants and agencies, then home services. Free 30 days,
   capped jobs, weekly feedback, anonymised receipt permission.
4. Paid conversion gate: verify rates, lock pricing, publish
   support runbook, stop button, ledger export, disconnect and
   deletion policy, and get Inan's approval for real Stripe,
   real AWS spend, and the published price, each separately.
5. Public launch and, later, Sigil verification as a service.

Known gaps, do not hide them:
- SMS state is in-memory only. Production needs a per-tenant
  persistent store.
- Sealbox redaction pass is designed, not wired into an APE job.
- Stripe v1 is one-time payment, not subscription billing.
- Fargate at 256 CPU / 512 MB is roughly $9 per always-on tenant
  per month, which breaks the shared-EC2 pricing examples.
  Recompute pricing before publishing a price for this path.
- Docker images were not built here (no docker in sandbox).
- Real Fargate startup, ALB routing, and secret injection are
  unproven live, only against a local stub.
- SMS trial numbers are limited to verified recipients until US
  SMS registration completes.

## How to pick this up

1. Read README.md, then this file, then provisioning/SECURITY.md.
2. Run the three test commands in README.md. All must pass
   before you claim anything works.
3. Pick the next item from the Not done list above, in order.
   Do not skip a gate to start a later phase.
4. Work on a branch, open a PR, wait for CI, and wait for Inan's
   call before merging. See docs/SDLC.md.
5. After each phase, update this file: change Last updated, move
   the finished item to Done with its test output, add the new
   next item, and append a dated entry to the Phase log below.
   Never delete or rewrite an old Phase log entry. Append only.

## Phase log

- 2026-10-31, Bot review fixes (PR #6, unmerged at write time):
  addressed all 6 Codex findings on PRs #3, #4, #5. Sealbox
  phone gate now catches contiguous numbers (+14155552671,
  14155552671, 4155552671) and literal token text is marked
  :literal so it can never resolve to an earlier message's
  value. Email dedup is scoped to the tenant after the
  recipient is resolved, opt-in now requires an explicit START
  command, and Authentication-Results is read case-insensitively.
  Docs fixed too: the submission draft and handoff no longer
  list the Wonder loop as not done. SMS tests 15 checks, email
  tests 10 checks, Stripe 12, all pass locally.
- 2026-10-31, Email intake: provisioning/email/email-intake.js
  added, mirroring SMS. One job per accepted email, tenant by
  agent address, spam keyword and auth-fail screen, unsubscribe
  and opt-out, rate limit, Sigil intake record, Sealbox tokens
  in dispatch subject and body, reply returned as draft only,
  never sent by this module. Email tests: 8 checks, all pass.
  CI now runs the email tests too.
- 2026-10-31, Sealbox SMS wiring: provisioning/sealbox.js added
  and wired into the SMS webhook. Dispatch bodies now carry
  tenant-scoped tokens for emails and phones, not raw PII, with a
  schema-fixed audit event and no raw PII in the audit log.
  Token maps are per tenant and in memory per handler, the same
  limitation as the SMS handler's other state. Production vault
  store is still to do. SMS tests grew from 10 to 13 checks, all
  pass, plus Stripe 12 and AWS dry run pass.
- 2026-10-31, Meta loop: Wonder-in-loop VERIFIED in the demo copy
  (local, not yet a public repo). Muse Wonder 1.0 drove the APE
  loop through the connector credential. Allow case: finish called,
  explicit_final_answer, outcome "wonder loop test". Block case:
  two sigil_blocked:revoked steps, Wonder stopped retrying, blocked
  tool never ran. Found and fixed a real gap in the same run: the
  loop's terminal finish path bypassed invokeTool, so a gated finish
  was never checked; it now goes through the gate first. Tests
  after the fix: 13 gate/provider plus 184 original suite, all pass.
  Still open: demo copy public repo, gate threshold confirmation,
  problem statement, video, and submit go-ahead.
- 2026-10-31, Phase 0, PR #1 merged: CI fix for AWS dry run on
  machines with docker installed. Main CI is green after the
  merge. Auto-merge authorized for this repo loop, under the
  rule above.
- 2026-10-31, Phase 0: Repo created public as
  fernandogarzaaa/ape-business. Onboarding site, provisioning
  prototype, pipeline, Stripe test mode, SMS test mode, AWS dry
  run, security doc, pricing, and this handoff, all committed to
  main as the initial import. $0 spent. Meta scope changed to
  full product v1. Next: Meta submission decisions, then Phase 1.
