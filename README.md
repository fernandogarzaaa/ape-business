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
