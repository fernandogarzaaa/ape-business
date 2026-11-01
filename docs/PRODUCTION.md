# Production runbook

Status: code-complete for test mode, $0 spent. Nothing is live until
Inan hands over each key and approves each spend separately
(HANDOFF.md hard rules). This page is the checklist for that day.

## Key handover (names only — values via Secure Vault, never chat)

| Env name | Where it goes | Notes |
|---|---|---|
| `APE_API_TOKEN` | API hosts env | Admin Bearer for provisioning/pipeline. Rotate: set new, restart, revoke old. |
| `STRIPE_SECRET_KEY` | Checkout caller env | Test key first (`sk_test_…` via Vault). Live key is a separate approval. |
| `STRIPE_WEBHOOK_SECRET` | Webhook host env | From the Stripe webhook endpoint (`whsec_…`). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | SMS host env | Trial number until 10DLC completes; verified recipients only. |
| `SMS_PUBLIC_URL` | SMS host env | Exact public webhook URL; signature validation depends on it. |
| `EMAIL_WEBHOOK_SECRET` | Email host env | Bearer the mail provider presents to `/email/webhook`. |
| `AWS_ROLE_ARN` | GitHub `production` Environment secret | OIDC role for the deploy workflow. No long-lived AWS keys in GitHub. |
| `APE_HEALTH_TOKEN` | Deploy workflow secret | Bearer for authenticated health checks. Never printed. |

GitHub `production` Environment (required reviewer: Inan) holds:
`AWS_ROLE_ARN`, `AWS_REGION`, `AWS_ACCOUNT_ID`, `APE_CLUSTER`,
`APE_VPC_ID`, `APE_SUBNETS`, `APE_SECURITY_GROUP`,
`APE_EXECUTION_ROLE_ARN`, `APE_ALB_LISTENER_ARN`, `APE_PUBLIC_DOMAIN`,
`APE_HEALTH_TOKEN`. Vars: `ECR_REPOSITORY=ape-tenant`,
`CADDY_ECR_REPOSITORY=ape-caddy`.

## Deployer IAM (least privilege sketch for the OIDC role)

- `ecr:*` on the two repositories above only (create with scan-on-push,
  immutable tags — the workflow does this idempotently).
- `ecs:RegisterTaskDefinition/DeregisterTaskDefinition/RunTask/StopTask/ListTasks`
  on `ape-tenant-*` families/cluster.
- `iam:CreateRole/DeleteRole/PutRolePolicy/DeleteRolePolicy/TagRole`
  on `arn:aws:iam::<acct>:role/ape-tenant-*` only.
- `iam:PassRole` ONLY for `ape-tenant-*` roles, conditioned
  `iam:PassedToService: ecs-tasks.amazonaws.com` (an unscoped PassRole
  plus RegisterTaskDefinition is a privilege-escalation path).
- `secretsmanager:CreateSecret/DeleteSecret/GetSecretValue` on
  `ape-tenant-*/bearer*`; `logs:CreateLogGroup/PutRetentionPolicy` on
  `/ape/tenants/*`; `elasticloadbalancing:CreateTargetGroup/CreateRule/RegisterTargets`
  on the ALB. Execution role (per task) needs
  `secretsmanager:GetSecretValue` for secret injection + logs.

## Going live, in order (each step is Inan's separate approval)

1. Stripe test keys in Vault → run `stripe listen` forward to
   `/api/webhooks/stripe` → one test checkout → tenant `paid` → `ready`.
2. Twilio test number → `SMS_PUBLIC_URL` set → STOP/START verified
   from a real handset (carrier handling of "Stop." included).
3. AWS: create cluster/VPC/ALB + listener + ACM cert → set the
   Environment secrets → dispatch **Deploy tenant** for one tenant →
   health check green → text + email receipt from the real endpoint.
4. Only then: live Stripe key, published price (re-verify every rate
   in PRICING.md, Fargate mode), retention paragraph below in force.

## Retention and deletion (Phase 1 gate item 7 — now written)

- Kept for audit: tenant record, deployment record, job ledger,
  Sealbox audit hashes, payment intent ids. Raw message bodies stay
  in the tenant's own store rows, never in logs.
- CloudWatch: 30-day retention (deploy sets it). Log groups are
  RETAINED on rollback; export before any manual deletion.
- Tenant export: `SELECT data FROM jobs WHERE tenant_id = ?` plus
  tenant/deployment rows — one JSON bundle per tenant.
- Tenant deletion: rollback (secret enters 7-day recovery), then
  delete tenant + jobs + dedup + opt-out rows for that tenant id.
  The audit-hash rows may be kept anonymized (tenant id + counts,
  no content) for abuse review.

## Stop button and support basics

- Stop one tenant now: `node provisioning/aws/rollback.js <id> --live`
  (stops task, deregisters, secret to recovery, logs retained).
- Suspend billing: Stripe Dashboard → cancel subscription; the
  `customer.subscription.deleted` webhook marks the tenant
  `suspended` automatically.
- Ledger export: the jobs table query above. No tenant data leaves
  except to the tenant that owns it.

## What is still NOT claimed

- No live Stripe/AWS/SMS has run. First live run is step 1–3 above.
- Sigil gate runs in the APE loop (separate demo copy); intake
  handlers record `intake_only_no_tool_dispatch` and claim no check.
- Sealbox token maps persist in the store DB. A production vault
  (Secrets Manager per tenant) replaces the DB table without an API
  change; names/addresses in free text are still not tokenized.
