# APE pricing: AWS usage plus profit

Model: cost-plus, per business, per month.

## Formula

```
usage_cost = infra + model + admin
monthly_price = base_platform_fee + usage_cost * (1 + margin)
```

- Base platform fee: $19 per business per month. Covers tenant isolation, vault, dashboard, and support. This is the only flat part.
- Infra: EC2 share plus storage plus transfer. One small instance shared across tenants in this prototype model. Tenants per instance is an input, default 10.
- Model: tokens per job times the model rate. Default estimate uses 800 input tokens and 400 output tokens per step when the caller does not give exact tokens.
- Admin: $2 per tenant per month, amortised vault, monitoring, backups, and support.
- Margin: 40 percent on usage cost. That is the profit. Change one number in server.js to change it.

## Rates in the prototype (verify before publishing)

These are editable estimates, not live AWS quotes. Check the AWS pricing page and the Meta Model API Billing page before putting any number on the github.io site or in a sales message.

- EC2 small instance: $15 per month, shared
- EBS: $0.10 per GB per month
- Transfer: $0.09 per GB
- Model input: $4 per 1M tokens
- Model output: $20 per 1M tokens

## Example prices (from the calculator, 10 tenants per instance, 10 steps per job, 5 GB storage)

- Small, 100 jobs a month: $40.28 per month, $0.40 per job
- Medium, 1,000 jobs a month: $181.40 per month, $0.18 per job
- Large, 5,000 jobs a month: $808.60 per month, $0.16 per job

Exact numbers come from GET /api/pricing/calculate with real job counts. The per-job price falls as volume rises, because the base fee and the EC2 share spread across more jobs, while model cost stays linear.

## Tiers built from the same formula (suggested, not locked)

- Starter: base fee plus usage, capped at 200 jobs a month. Good for a first business proving the agent.
- Growth: base fee plus usage, capped at 2,000 jobs a month, with priority discovery and more connectors.
- Scale: custom tenants per instance, dedicated instance option, custom margin negotiation.

Do not sell a flat unlimited tier. Unlimited breaks a cost-plus model, because model cost grows with every job and the margin would turn negative at volume.

## What is not in the price yet

- Real OAuth app review costs, if a provider charges them.
- Human support time beyond the $2 admin amortisation.
- Dedicated instance pricing, which replaces the shared EC2 share with a full instance price.
- Taxes, payment processing fees, and currency conversion for PH businesses paying in PHP.

## Friction note for owners

Pricing must be visible before they connect anything. The github.io page should show the calculator, with jobs per month as the one slider an owner understands, and the breakdown underneath. No surprise bill at month end. Cap jobs per month in the tenant, and stop at the cap with a clear upgrade prompt instead of silently overrunning.

## Deploy-mode pricing (added with the production build)

The examples above price the shared-EC2 mode. Fargate mode
(`APE_DEPLOY_MODE=fargate`, one always-on task per tenant) prices
infra at $9.01/tenant/mo (0.25 vCPU / 0.5 GB, us-east-1) plus an
amortized ALB+NAT platform share ($52.40 / platformTenants). At 100
jobs that is about $50.81/month, not $40.28. The calculator branches
on deploy mode; verify every rate before publishing either price.
