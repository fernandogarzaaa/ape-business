# APE for Business: prebuilt-image deploy path (ECS Fargate)

## Choice: ECS Fargate RunTask, not EC2 RunInstances

Fargate wins on the three criteria that decide pay-to-ready. Startup
time: a Fargate task starts from a prebuilt image, typically a 30 to
90 second pull and start, with no apt, npm, git, or user-data install
on every boot. An EC2 instance from a prebuilt AMI is comparable on
a good day but varies with AMI build drift, instance boot, and
user-data, which is exactly the variability the existing
user-data.sh path already suffers from. Cost: Fargate at 0.25 vCPU
and 0.5 GB is roughly $9 per always-on tenant per month at published
Fargate rates, which is higher than the $1.50 per tenant shared EC2
share assumed in PRICING.md, so PRICING.md must be revised before any
price is published; the $40.28 small-tier example does not survive a
dedicated Fargate task unchanged. Isolation: Fargate gives each
tenant its own task, its own task IAM role, its own log group, and
its own secret, with no shared host to patch, no SSH surface, and no
host-level cross-tenant leakage path. EC2 per tenant would give a
whole host per tenant at similar cost plus patching and SSH burden.
Fargate's task role is also the exact shape the pipeline spec
already requires: ecs:RunTask with ape-tenant-<tenant-id> as the
task role, nothing else.

## Layout

- Dockerfile: APE image, Node 22, non-root user, APE on loopback 8787.
- entrypoint.sh: starts APE, refuses to run without APE_REQUIRE_AUTH=1
  and a bearer token supplied by environment (Secrets Manager injection
  in the task definition, never baked into the image).
- Caddyfile.alb: Caddy reverse proxy for the Fargate path. The ALB
  terminates TLS; Caddy listens on 8080 inside the task and proxies
  to APE on loopback 8787, preserving the loopback-only APE bind.
- Caddyfile.standalone: Caddy automatic HTTPS for a standalone run
  without an ALB. Not used in the Fargate path.
- task-definition.json: template with __PLACEHOLDER__ values, two
  containers (ape, caddy), awslogs to the tenant log group, bearer
  token injected from the tenant secret.
- policy.js: the one tenant IAM policy, as a pure function.
- deploy.js: creates exactly three per-tenant resources (IAM role,
  Secrets Manager secret, CloudWatch log group), registers the task
  definition, and runs one task. Default mode is dry-run. Live mode
  refuses unless --live and APE_DEPLOY_LIVE_CONFIRMED=1 are both set.
- rollback.js: reverses a deploy, in reverse order, once. No loop.
- health-check.js: GET /discover (status) plus GET /tools (read-only
  discovery). Both must pass. No write, no token in output.
- build-image.sh: builds the APE image. Fails loud if docker is
  absent or if a secret value appears in the build context.
- dry-run.js: stub harness. Records the exact AWS calls deploy.js
  would make, runs the health check against a local stub APE server,
  and asserts scope, order, and rollback. This is the verification
  for this pass. It creates no AWS resource and spends nothing.

## Per-tenant scope, exact

- IAM role: ape-tenant-<tenant-id>, trust ecs-tasks.amazonaws.com.
- Policy: S3 GetObject/PutObject on arn:aws:s3:::ape-tenants/
  <tenant-id>/* only; Secrets Manager GetSecretValue on that
  tenant's secret ARN only; CloudWatch Logs CreateLogStream and
  PutLogEvents on that tenant's log group ARN only. No EC2, no IAM,
  no other tenant, no wildcard resource.
- Secret: ape-tenant-<tenant-id>/bearer, one JSON field bearer_token.
- Log group: /ape/tenants/<tenant-id>.
- Nothing else is created per tenant by deploy.js.

## Pre-provisioned platform prerequisites (not created by deploy.js)

These are platform resources, not per-tenant resources, and they need
Inan's separate AWS approval before any live run: ECS cluster, VPC
subnets and security group (private subnets with NAT, task public IP
disabled), ALB with host-based routing per tenant, platform
execution role (ECR pull, logs, and read of the task's own secret
only), S3 bucket ape-tenants, and the APE image in ECR. deploy.js
takes all of these as environment names, never as hardcoded values,
and refuses to run live without them.

## What dry-run proves, and what it does not

Proves: call order, exact scopes, rollback order, health check
logic against a stub that serves the real /discover and /tools
shapes, and that live mode refuses without explicit confirmation.
Does not prove: real Fargate startup time, real ALB routing, real
Secrets Manager injection, or real cost. Those need Inan's AWS
account, IAM approval, and a live test run in a sandbox account.
