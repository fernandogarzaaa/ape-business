// APE provisioning backend prototype.
// Node only, no dependencies. Runs on EC2 beside APE, behind Caddy for TLS.
// This prototype stores tenants in memory plus a JSON file per tenant.
// It does NOT contact Shopify, Salesforce, Gmail, or any real system.
// OAuth and discovery here are simulated shapes for the real flow.
// Real version must: encrypt tokens at rest, isolate one APE process per
// tenant, enforce egress allowlists, and never log a token value.
//
// Endpoints:
//   POST /api/tenants            {businessName, stage, industry, objective, profile, connectors[], policy, maxSteps, maxCostUsd}
//   POST /api/tenants/:id/connect {system}   -> mock OAuth start (no real OAuth yet)
//   POST /api/tenants/:id/provision          -> creates tenant bundle, endpoint, agent card
//   POST /api/tenants/:id/discover           -> simulated read-only discovery, outcome unverified
//   GET  /api/tenants/:id                    -> status, no secrets
//   GET  /api/pricing/calculate?jobs=&steps=&inputTokens=&outputTokens=&storageGb=&tenantsPerInstance=
//        -> AWS cost estimate plus margin price. Rates are editable estimates.
//        Verify every rate on the AWS pricing page before publishing prices.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8788;
const DATA_DIR = path.join(__dirname, 'tenants');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---- Pricing model: cost-plus. Edit RATES, then re-verify on AWS pricing. ----
const RATES = {
  // Illustrative on-demand rates, US East, to verify before any published price.
  ec2MonthlyUsd: 15.00,        // one small instance, shared across tenants
  ebsPerGbMonthUsd: 0.10,
  transferPerGbUsd: 0.09,
  adminPerTenantMonthUsd: 2.00, // vault, monitoring, backups, support amortised
  // Model rates from the Meta Model API research (Muse Wonder, Standard).
  // Verify on the Billing page before quoting in submission or sales text.
  modelInputPerMTokUsd: 4.00,
  modelOutputPerMTokUsd: 20.00,
  basePlatformFeeUsd: 19.00,   // per business per month, covers tenant isolation
  margin: 0.40,                 // 40 percent profit on measured usage cost
};

function price(input) {
  const jobs = Math.max(0, Number(input.jobs) || 0);
  const steps = Math.max(0, Number(input.steps) || 0);
  const inputTokens = Math.max(0, Number(input.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(input.outputTokens) || 0);
  const storageGb = Math.max(0, Number(input.storageGb) || 0);
  const transferGb = Math.max(0, Number(input.transferGb) || 0);
  const tenantsPerInstance = Math.max(1, Number(input.tenantsPerInstance) || 10);
  // Model cost: if caller gives tokens per job, use them; else estimate from steps.
  const tokensIn = inputTokens || jobs * steps * 800;
  const tokensOut = outputTokens || jobs * steps * 400;
  const modelCost = (tokensIn / 1e6) * RATES.modelInputPerMTokUsd + (tokensOut / 1e6) * RATES.modelOutputPerMTokUsd;
  const infraCost = RATES.ec2MonthlyUsd / tenantsPerInstance + storageGb * RATES.ebsPerGbMonthUsd + transferGb * RATES.transferPerGbUsd;
  const usageCost = infraCost + modelCost + RATES.adminPerTenantMonthUsd;
  const priceUsd = RATES.basePlatformFeeUsd + usageCost * (1 + RATES.margin);
  return {
    inputs: { jobs, steps, storageGb, transferGb, tenantsPerInstance },
    breakdownUsd: {
      basePlatformFee: round(RATES.basePlatformFeeUsd),
      infra: round(infraCost),
      model: round(modelCost),
      admin: round(RATES.adminPerTenantMonthUsd),
      usageCost: round(usageCost),
      marginRate: RATES.margin,
      marginUsd: round(usageCost * RATES.margin),
    },
    monthlyPriceUsd: round(priceUsd),
    perJobUsd: jobs ? round(priceUsd / jobs) : null,
    note: 'Estimate only. Verify EC2, EBS, transfer, and model rates before publishing.',
  };
}
function round(n) { return Math.round(n * 100) / 100; }

// ---- Tenants ----
function token() { return crypto.randomBytes(32).toString('hex'); }
function saveTenant(t) {
  fs.writeFileSync(path.join(DATA_DIR, t.id + '.json'), JSON.stringify(t, null, 2));
}
function loadTenant(id) {
  const f = path.join(DATA_DIR, id + '.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}
function publicTenant(t) {
  const { bearerToken, ...rest } = t;
  return rest;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // Pricing calculator
  if (req.method === 'GET' && url.pathname === '/api/pricing/calculate') {
    return send(res, 200, price(Object.fromEntries(url.searchParams)));
  }

  // Create tenant
  if (req.method === 'POST' && url.pathname === '/api/tenants') {
    const b = await readBody(req);
    const id = 'tn_' + crypto.randomBytes(6).toString('hex');
    const t = {
      id,
      businessName: b.businessName || 'My Business',
      stage: b.stage || 'new',
      industry: b.industry || 'other',
      objective: b.objective || '',
      profile: b.profile || 'repo-triage',
      connectors: Array.isArray(b.connectors) ? b.connectors : ['web'],
      policy: b.policy || 'standard',
      maxSteps: b.maxSteps || 50,
      maxCostUsd: b.maxCostUsd || 5,
      status: 'created',
      connected: [],
      endpoint: null,
      agentCard: null,
      discovery: null,
      createdAt: new Date().toISOString(),
    };
    saveTenant(t);
    return send(res, 201, publicTenant(t));
  }

  // Connect a system (mock OAuth start; real version redirects to provider)
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'tenants' && parts[3] === 'connect') {
    const t = loadTenant(parts[2]);
    if (!t) return send(res, 404, { error: 'tenant_not_found' });
    const b = await readBody(req);
    const system = b.system || 'shopify';
    if (!t.connected.includes(system)) t.connected.push(system);
    t.status = 'connected';
    saveTenant(t);
    return send(res, 200, {
      tenantId: t.id, system, oauth: 'mock',
      note: 'Real version: redirect owner to provider OAuth, store token encrypted per tenant, never log it.',
      next: 'POST /api/tenants/' + t.id + '/provision',
    });
  }

  // Provision: make this business its own APE bundle
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'tenants' && parts[3] === 'provision') {
    const t = loadTenant(parts[2]);
    if (!t) return send(res, 404, { error: 'tenant_not_found' });
    t.bearerToken = token();
    t.endpoint = 'https://api.example.invalid/tenants/' + t.id + '/mcp';
    t.agentCard = {
      name: 'ape-mcp', business: t.businessName, description: t.objective, version: '1.0.0',
      url: t.endpoint,
      skills: [{ id: t.profile, name: t.profile, description: t.objective, tags: ['agent', 'ape'] }],
      connectors: t.connected, capabilities: { streaming: false, pushNotifications: false },
    };
    t.status = 'provisioned';
    saveTenant(t);
    // Return token once, like a real provisioning response. Caller must save it.
    return send(res, 200, { ...publicTenant(t), bearerToken: t.bearerToken, warning: 'Save this token now. It is not returned again by GET status.' });
  }

  // Discover: simulated read-only learning, outcome unverified until owner approves
  if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'tenants' && parts[3] === 'discover') {
    const t = loadTenant(parts[2]);
    if (!t) return send(res, 404, { error: 'tenant_not_found' });
    if (t.status !== 'provisioned') return send(res, 409, { error: 'provision_first' });
    const learnLines = {
      shopify: 'Products, inventory, orders, customers',
      salesforce: 'Accounts, contacts, opportunities, pipeline',
      gmail: 'Customer threads, follow ups, commitments',
      calendar: 'Meetings, deadlines, availability',
      database: 'Schema and allowed tables, read-only',
      slack: 'Channels and team knowledge',
      sheets: 'Reports, price lists, trackers',
      github: 'Repos, issues, past decisions',
      web: 'Public research, checked before repeating',
    };
    t.discovery = {
      mode: 'read-only simulation',
      learned: t.connected.map((s) => ({ system: s, learned: learnLines[s] || 'Connected system inventory' })),
      outcome: 'success',
      outcomeStatus: 'unverified',
      note: 'Draft business profile. Owner must verify before jobs act on it. Simulation only, no real system was contacted.',
    };
    t.status = 'discovered';
    saveTenant(t);
    return send(res, 200, publicTenant(t));
  }

  // Status (never returns the bearer token)
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'tenants' && parts[2]) {
    const t = loadTenant(parts[2]);
    if (!t) return send(res, 404, { error: 'tenant_not_found' });
    return send(res, 200, publicTenant(t));
  }

  return send(res, 404, { error: 'not_found', routes: ['POST /api/tenants', 'POST /api/tenants/:id/connect', 'POST /api/tenants/:id/provision', 'POST /api/tenants/:id/discover', 'GET /api/tenants/:id', 'GET /api/pricing/calculate'] });
});

if (require.main === module) {
  server.listen(PORT, () => console.log('APE provisioning prototype on http://localhost:' + PORT));
}
module.exports = { server, price, RATES };
