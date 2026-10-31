# Automated deployment pipeline: pay to ready APE in a few minutes

Goal: a business owner pays, and within a few minutes they have their own
APE to use. No YAML, no terminal, no AWS console for the owner.

## Flow, in order

```
Owner fills onboarding
  -> Checkout (Stripe)
  -> Webhook verifies payment (signature, not client callback)
  -> Tenant created (idempotent on payment intent id)
  -> AWS provisioning starts
  -> IAM role created for that tenant only
  -> APE deployed for that tenant only
  -> Health check passes
  -> Owner gets endpoint, agent card, and bearer token (once)
  -> Status: ready
```

Idempotency is the rule that makes this safe. The payment intent id is the
key. A duplicate webhook, a retry, or a double click must never create a
second tenant, a second IAM role, or a second charge. Every step checks
whether its output already exists before it runs.

## What "their own IAM" means here (important choice)

Do NOT create a human AWS IAM user per business. That is the wrong shape:
it hands out long lived AWS credentials, it is hard to scope, and it is
hard to revoke cleanly.

Each business gets, instead:

- One IAM role, named `ape-tenant-<tenant-id>`, used only by that
  business's APE task. No console login, no human key.
- A policy scoped to that tenant only:
  - S3: only `ape-tenants/<tenant-id>/*`
  - Secrets Manager: only the secret named for that tenant
  - CloudWatch Logs: only the log group for that tenant
  - Nothing else. No EC2, no IAM, no other tenant's resources.
- One APE bearer token for API access, returned once at provision time,
  stored encrypted per tenant, never in a profile file, never in a log.
- One endpoint per tenant, routed by subdomain or path, so one business
  can never reach another business's APE by guessing a URL.

If a business later wants to own the AWS account itself, that is a second
mode, not a change to this one: deploy into their account with a
cross-account role they approve, using the same pipeline steps. Do not
mix the two modes in one tenant.

## Timing budget for "a few minutes"

Target: under 5 minutes from verified payment to ready. The only way to
hit that reliably is a prebuilt image, not install-from-scratch per tenant.

- Payment webhook verification: seconds
- Tenant and IAM role creation: under 30 seconds
- APE deploy from a prebuilt container image (ECS Fargate task, or an
  EC2 AMI with APE already installed): 60 to 90 seconds
- Health check (APE status plus one read-only discovery call): under 30 seconds
- Total, typical: 2 to 3 minutes

The existing EC2 user-data script installs Node and APE from scratch on
every boot. That is fine for a first manual deploy. It is too slow and
too variable for a paid pipeline. Build one APE image once, deploy that
image per tenant, and keep user-data only for the first prototype.

## Real AWS mapping (prototype simulates these)

| Pipeline step | Real AWS action | Resource | Rollback on failure |
|---|---|---|---|
| Tenant isolate | Create tenant directory and env file, 0600 | App data, per tenant | Delete tenant record |
| IAM role | iam:CreateRole, iam:PutRolePolicy | Role ape-tenant-<id> | iam:DeleteRolePolicy, iam:DeleteRole |
| Secret | secretsmanager:CreateSecret | One secret per tenant | secretsmanager:DeleteSecret |
| Deploy | ecs:RunTask with the tenant task role, or ec2:RunInstances from a prebuilt AMI | One task or instance per tenant | ecs:StopTask, or ec2:TerminateInstances |
| Route | Route 53 record or ALB host rule | tenant subdomain to task | Delete record or rule |
| Health | GET APE status, then one read-only discovery | None, read-only | Mark failed, do not mark ready |
| Ready | Return endpoint, agent card, bearer token once | None | Revoke token, stop task |

The deploy role that runs this pipeline must itself be scoped: it may
create tenant roles and tasks, but it must never be able to read another
tenant's secret, and it must never use root credentials. Use the IAM
user fernandogarzadev pattern from the PayPilot work: a named IAM
identity, never root.

## Payment

- Checkout first, provisioning second. Never provision on a client side
  "payment succeeded" callback. Only a webhook with a verified signature
  starts provisioning.
- Amount comes from the pricing calculator: base fee plus usage cost
  times 1 plus margin. The checkout amount and the calculator amount
  must match, or the pipeline stops and a human looks at it.
- On provisioning failure after payment: stop, keep the payment record,
  do not mark ready, and surface a refund or retry choice to the owner.
  Never silently retry a failed AWS deploy in a loop, and never auto
  refund without the owner's explicit call in the real version.
- Test mode first: Stripe test keys, mock webhook, simulated AWS steps.
  Real keys go in the vault, never in chat, memory, or a repo file.

## Friction killers for owners

- OAuth connect, not API keys, for Shopify, Salesforce, and Gmail.
- One price shown before checkout, with the breakdown from the
  calculator, and a monthly cap the owner sets.
- A status page during the few minutes: payment verified, IAM created,
  APE deploying, health check, ready. No silent waiting.
- One test button after ready: a read-only discovery run against their
  connected systems, with a draft profile to approve.
- Disconnect and revoke in one click: stops the task, deletes the role
  policy, revokes the token, and keeps the ledger for audit.

## What the prototype in this folder does

`pipeline.js` simulates this exact state machine locally. Payment is a
mock intent, AWS steps are mock records with the same names and scopes
as the real steps, and timing is compressed for demo. It proves the
order, the idempotency, and the ready state. It does not spend AWS
money, create real IAM roles, or contact Stripe. Those are the next
build, after the state machine is approved.
