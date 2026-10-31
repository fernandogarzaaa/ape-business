# Phase 1 Spec: Real Onboarding

Goal: turn the prototype in this repo into a real onboarding path,
still $0 spent until Inan approves each live step separately.

## Exit gate

Phase 1 is done only when one demo tenant goes from test payment
to ready in under 5 minutes, passes a text test and an email test,
and shows a receipt in the ledger. If it cannot do both channels,
Phase 1 is not done.

## Work items, in order

1. Shopify OAuth first, then Gmail OAuth. One connector at a time,
   read-only first, owner-verified profile before any write.
   Secrets as env names only, one credential per system per tenant.
2. Encrypted per-tenant vault, replacing plain prototype files.
   One Secrets Manager secret per tenant in production, one local
   vault file in test mode, never committed.
3. Prebuilt APE image, built on a docker machine. Docker is absent
   in the sandbox, so build-image.sh correctly refuses there.
   Do not fake a build.
4. github.io wired to the EC2 provisioning API, instead of
   generating files in the browser. Site remains static. The API
   is the backend.
5. Stripe test mode, with test keys via Secure Vault only. Test
   Checkout to webhook to ready, then stop. Live mode is a
   separate approval.
6. SMS test number and inbound email test inbox, both feeding one
   job model, with Sealbox tokenization wired between connector
   read and dispatch, per provisioning/SECURITY.md section 4.
7. Retention and deletion paragraph, written before any real money
   is taken. What is kept for audit, for how long, and how a
   tenant exports and deletes their data, in plain words.

## What Phase 1 does not do

- No real charge, no real AWS resource, no real number purchase,
  until Inan approves that exact spend.
- No Salesforce, home services, or consultant live connectors.
  Shopify is first. Others remain catalog templates.
- No subscription billing. Stripe v1 is one-time first-month
  payment. Subscription is a separate, later change.
- No multi-tenant scaling, no dedicated instances, no enterprise
  review. Those are Phase 5, explicitly parked.

## Tests that must pass

- SMS, Stripe, and AWS dry run tests in README.md, all green in CI.
- One end-to-end test-mode tenant: payment, provision, text,
  email, receipt, all logged, all with test credentials only.
