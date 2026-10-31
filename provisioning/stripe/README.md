# Stripe integration: test mode only

Real Stripe code paths, no real charge, no live API call in this build.

## Files

- `verify.js`: HMAC-SHA256 verification of the Stripe-Signature header
  (timestamped payload, 300s tolerance, constant-time v1 compare).
- `checkout.js`: Checkout session params from the calculator in
  `../server.js` (base $19 + usage x 1.40), plus `createCheckoutSession`
  which posts to api.stripe.com only when a key is supplied.
- `handler.js`: webhook handler. Order: verify signature, ignore
  non-succeeded events, check amount against the calculator, check
  idempotency on payment intent id, only then call provision.
  A failed provision is NOT recorded, so a redelivery can retry.
- `webhook-server.js`: HTTP server on STRIPE_WEBHOOK_PORT (default
  8790). Reads the RAW body, because parsing JSON first would break
  the signature. Wires the handler to the existing `runPipeline`
  in `../pipeline.js`.
- `test-stripe.js`: 12-check harness. Run it with
  `node ~/workspace/ape-provisioning/stripe/test-stripe.js`.

## Secrets (env names only, values from Secure Vault)

- `STRIPE_SECRET_KEY`: Stripe secret key, test mode for this build.
- `STRIPE_WEBHOOK_SECRET`: webhook endpoint signing secret.
- `STRIPE_WEBHOOK_PORT`: optional, default 8790.

No key value is in any file here. The test harness generates a
random test-only signing secret per run and never persists it.

## What is real versus what still needs Inan

Real in this build: signature verification, Checkout param building
from the calculator, amount-mismatch guard, idempotent webhook
handling, and the raw-body webhook server wired to runPipeline.

Still mock, by design: `runPipeline`'s AWS steps are mock records
(400ms demo timing), not real IAM/ECS/EC2 actions. See
DEPLOYMENT_PIPELINE.md for the real AWS mapping.

Still needed from Inan, via Secure Vault, before any live test:
Stripe test keys (secret + webhook secret), and a Stripe test-mode
webhook endpoint pointed at the webhook server. After that, a real
Stripe test-mode Checkout session can be created and its webhook
verified end to end. Live mode is a separate, explicit approval
after test mode passes; nothing in this build flips to live on its own.

## Open risks

- Checkout v1 is a one-time first-month payment, not a recurring
  subscription. Subscription billing changes the webhook event type
  and the idempotency key, and is a follow-up, not a silent swap.
- The default processed-intent store is a local JSON file. It is
  correct for a single server; a multi-process deploy needs a shared
  store (database or Redis) before production.
- Amount check uses metadata jobs/steps/storageGb written at
  Checkout time. If a session is created outside this builder,
  without that metadata, the check is skipped and the pipeline
  relies on signature + intent id alone.
