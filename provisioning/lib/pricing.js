// Pricing: cost-plus, shared by server.js, stripe/checkout.js, and
// stripe/handler.js so the quoted price and the verified price can
// never drift apart. Pure functions, no I/O.
//
// Two deploy modes, because the audit found the calculator pricing
// a shared EC2 ($1.50/tenant) while the task definition runs an
// always-on Fargate task ($9.01/tenant/mo, verified:
// (0.25 x $0.04048 + 0.5 x $0.004445) x 730h, us-east-1 x86):
// - shared (default; the $40.28 example in PRICING.md)
// - fargate (APE_DEPLOY_MODE=fargate; one task per tenant + an
//   amortized ALB/NAT platform share). Publishing a price requires
//   re-verifying every rate, as PRICING.md states.
'use strict';

const RATES = {
  ec2MonthlyUsd: 15.00,
  tenantsPerInstanceDefault: 10,
  fargateVCpuHourUsd: 0.04048,
  fargateGbHourUsd: 0.004445,
  fargateCpu: 0.25,
  fargateMemGb: 0.5,
  hoursPerMonth: 730,
  // ALB (~$20/mo) + one NAT gateway (~$32.40/mo), amortized across
  // the tenants sharing the platform. At 1-3 tenants the $19 base
  // does not cover this; the divisor makes that visible, not hidden.
  platformFixedMonthlyUsd: 52.40,
  ebsPerGbMonthUsd: 0.10,
  transferPerGbUsd: 0.09,
  adminPerTenantMonthUsd: 2.00,
  modelInputPerMTokUsd: 4.00,
  modelOutputPerMTokUsd: 20.00,
  basePlatformFeeUsd: 19.00,
  margin: 0.40,
  maxJobs: 100000,
  maxStepsPerJob: 1000,
};

function round(n) { return Math.round(n * 100) / 100; }

function fargateMonthlyUsd() {
  return round((RATES.fargateCpu * RATES.fargateVCpuHourUsd +
    RATES.fargateMemGb * RATES.fargateGbHourUsd) * RATES.hoursPerMonth);
}

// Reject, never silently clamp: a $156M session from jobs=1e9 and a
// $24.60 default from jobs=NaN were both probed against the old code.
function validatePricingInput(input) {
  const i = input || {};
  const jobs = i.jobs != null ? Number(i.jobs) : 100;
  const steps = i.steps != null ? Number(i.steps) : 10;
  if (!Number.isInteger(jobs) || jobs < 0 || jobs > RATES.maxJobs) {
    throw new Error('jobs must be an integer between 0 and ' + RATES.maxJobs);
  }
  if (!Number.isInteger(steps) || steps < 0 || steps > RATES.maxStepsPerJob) {
    throw new Error('steps must be an integer between 0 and ' + RATES.maxStepsPerJob);
  }
  for (const k of ['storageGb', 'transferGb']) {
    const v = i[k] != null ? Number(i[k]) : 0;
    if (!Number.isFinite(v) || v < 0 || v > 10000) throw new Error(k + ' out of range');
  }
  return i;
}

function price(input) {
  const i = validatePricingInput(input);
  const jobs = i.jobs != null ? Number(i.jobs) : 100;
  const steps = i.steps != null ? Number(i.steps) : 10;
  const storageGb = Number(i.storageGb) || 0;
  const transferGb = Number(i.transferGb) || 0;
  const deployMode = i.deployMode || process.env.APE_DEPLOY_MODE || 'shared';
  const tokensIn = Number(i.inputTokens) || jobs * steps * 800;
  const tokensOut = Number(i.outputTokens) || jobs * steps * 400;
  const modelCost = (tokensIn / 1e6) * RATES.modelInputPerMTokUsd +
    (tokensOut / 1e6) * RATES.modelOutputPerMTokUsd;
  let infraCost;
  let platformCost = 0;
  if (deployMode === 'fargate') {
    infraCost = fargateMonthlyUsd() + storageGb * RATES.ebsPerGbMonthUsd +
      transferGb * RATES.transferPerGbUsd;
    const platformTenants = Math.max(1, Number(i.platformTenants) || 10);
    platformCost = RATES.platformFixedMonthlyUsd / platformTenants;
  } else {
    const tpi = Math.max(1, Number(i.tenantsPerInstance) ||
      RATES.tenantsPerInstanceDefault);
    infraCost = RATES.ec2MonthlyUsd / tpi + storageGb * RATES.ebsPerGbMonthUsd +
      transferGb * RATES.transferPerGbUsd;
  }
  const usageCost = infraCost + platformCost + modelCost + RATES.adminPerTenantMonthUsd;
  const priceUsd = RATES.basePlatformFeeUsd + usageCost * (1 + RATES.margin);
  if (!Number.isFinite(priceUsd)) throw new Error('pricing overflow');
  return {
    inputs: { jobs, steps, storageGb, transferGb, deployMode },
    breakdownUsd: {
      basePlatformFee: round(RATES.basePlatformFeeUsd),
      infra: round(infraCost),
      platform: round(platformCost),
      model: round(modelCost),
      admin: round(RATES.adminPerTenantMonthUsd),
      usageCost: round(usageCost),
      marginRate: RATES.margin,
      marginUsd: round(usageCost * RATES.margin),
    },
    monthlyPriceUsd: round(priceUsd),
    perJobUsd: jobs ? round(priceUsd / jobs) : null,
    note: 'Estimate only. Verify EC2/Fargate, EBS, transfer, ALB/NAT, and model rates before publishing.',
  };
}

module.exports = { price, RATES, round, fargateMonthlyUsd, validatePricingInput };
