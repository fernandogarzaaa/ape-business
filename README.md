# Sigil demo (Meta hackathon)

APE runs the agent. Before any tool call runs, a Sigil gate checks
that tool server's badge: trusted calls run, untrusted calls are
blocked, and both outcomes go to the audit trail. This is the demo
this repo submits for the Meta hackathon.

- Run the offline demo: `node demo/sigil-gate-demo.mjs`
- Gate tests: `node --test tests/sigil-gate.test.js tests/sigil-gate-invoke.test.js tests/sigil-gate-hardening.test.js tests/meta-provider.test.js` (22 tests)
- Start with `demo/README.md`. Gate code: `src/agent/sigil-gate.js`, wiring in `src/agent/registry.js`, Meta provider (Muse Wonder 1.0 via the Meta Model API, key from environment only) in `src/agent/providers.js`.

Honest labels, read before believing anything else on this page:

- Gate policy is PROPOSED, not confirmed: block high, critical,
  unknown, bad signature, and revoked; allow low and medium.
- fixture-server 0.1.0 is a Sigil test fixture, not a real MCP server.
- Everything beyond the demo loop is test mode or dry run, $0 spent.
  No live Stripe, AWS, or SMS is claimed.
- No production Sealbox vault is claimed.
- A badge proves identity, version, and risk level only, not that
  an agent is good at its job.

---

# APE for Business

One agent per business. A business adopts its own APE, for a new or
existing business, and customers reach that agent by text, by email,
or agent to agent. The agent is the product. There is no website
product to log into.

Status: early build, test mode only, $0 spent. Nothing here is live,
nothing is charged, nothing is published as a service yet. See
HANDOFF.md for the current phase and what is still mock.

## What it does

- Onboarding: business, connectors, budget, deployment, and agent
  identity (name, email, phone) in `site/index.html`.
- Trust gate: Sigil badge checked on every tool call, before the
  tool runs. See the Meta demo copy, which is a separate repo
  workspace, for the gate implementation.
- Provisioning: pay to ready pipeline in `provisioning/pipeline.js`,
  with one IAM role per tenant, an endpoint, and a bearer token.
- Payments: real Stripe Checkout and webhook signature verification
  in test mode, in `provisioning/stripe/`.
- SMS: real Twilio webhook in and out, with opt-out and rate limits,
  in test mode, in `provisioning/sms/`.
- Deploy: ECS Fargate deploy path with a prebuilt image, code and
  dry run only, in `provisioning/aws/`.
- Security: layered design, with the Sealbox content gate as a Day 1
  integration, in `provisioning/SECURITY.md`.

## What it does not do yet

- No real Stripe charge. No real AWS resource. No real phone number
  purchased. No real SMS sent.
- No live Shopify, Salesforce, Gmail, or database connector. The
  web connector is the only one that ships in APE today. The rest
  are catalog templates.
- No recurring subscription billing. Stripe v1 is a one-time
  first-month payment.
- No per-tenant persistent store for SMS jobs, opt-outs, and
  dedup. SMS state is in-memory in the current build.

## Layout

- `site/index.html` — static onboarding wizard. Saves nothing,
  sends nothing. GitHub Pages cannot run a backend.
- `provisioning/server.js` — tenant, connect, provision, discover,
  and pricing calculator backend (local prototype).
- `provisioning/pipeline.js` — checkout to ready pipeline.
- `provisioning/stripe/` — Stripe verification, Checkout, webhook.
- `provisioning/sms/` — Twilio webhook, jobs, opt-out.
- `provisioning/aws/` — Fargate deploy, IAM per tenant, Caddy.
- `provisioning/PRICING.md` — cost-plus pricing, editable estimates.
- `provisioning/DEPLOYMENT_PIPELINE.md` — pipeline and IAM design.
- `provisioning/SECURITY.md` — security layers and claim limits.
- `provisioning/PRODUCT_BRAINSTORM.md` — product decisions log.
- `HANDOFF.md` — phase log and pickup instructions. Update it
  after every phase. Never rewrite its history.

## Run the tests (no spend, no network)

```
node provisioning/sms/test-sms.js
node provisioning/stripe/test-stripe.js
node provisioning/aws/dry-run.js
node --check provisioning/server.js provisioning/pipeline.js
```

## Secrets rule

Env names only, never values. Stripe, Twilio, and AWS keys go
through Secure Vault when the owner provides them, never in chat,
code, files, or memory. A key in this repo is a bug, not a shortcut.

## License

MIT. See LICENSE.
