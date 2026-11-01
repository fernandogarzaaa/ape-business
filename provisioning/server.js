// APE provisioning backend.
// Node only, no npm dependencies (SQLite via node:sqlite).
// Runs on EC2 beside APE, behind Caddy for TLS. State lives in the
// store (provisioning/lib/store.js); bearer tokens are stored only
// as SHA-256 hashes and returned exactly once, at provision time.
//
// Auth model (env names only, values from the vault):
// - APE_API_TOKEN set: every /api/tenants route requires it as a
//   Bearer [REDACTED] Tenant-scoped routes also accept that tenant's own
//   bearer token. Unset: loopback-only prototype mode, warned loudly.
// - HOST defaults to 127.0.0.1. Binding wider without APE_API_TOKEN
//   is refused at startup.
//
// Endpoints:
//   POST /api/tenants            (admin) create tenant
//   POST /api/tenants/:id/connect   (admin or tenant token; mock OAuth)
//   POST /api/tenants/:id/provision (admin; once — repeat is 409)
//   POST /api/tenants/:id/discover  (admin or tenant token; simulation)
//   GET  /api/tenants/:id           (admin or tenant token; no secrets)
//   GET  /api/pricing/calculate     (public estimate)
//   GET  /healthz                   (public liveness, no internals)
'use strict';

const http = require('http');
const crypto = require('crypto');
const { createStore, isValidTenantId, hashToken } = require('./lib/store');
const { price, RATES } = require('./lib/pricing');
const { readJsonBody, sendJson, requireAdmin, tokenMatches } = require('./lib/http');

const PORT = process.env.PORT || 8788;
const HOST = process.env.HOST || '127.0.0.1';

function createServerWithStore(store) {
  // Boolean admin check that NEVER writes a response. requireAdmin
  // sends its own 401, so calling it here first ended the response
  // before the tenant-token check could run (Codex P1).
  function isAdmin(req) {
    const expected = process.env.APE_API_TOKEN || '';
    if (!expected) return true; // loopback prototype mode
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return tokenMatches(provided, expected);
  }
  function tenantAuthorized(req, res, tenantId) {
    if (isAdmin(req)) return true;
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (provided && store.tenantTokenMatches(tenantId, provided)) return true;
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }

  function publicTenant(t) {
    if (!t) return null;
    const { tokenHash, ...rest } = t;
    return rest;
  }

  function validCreate(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be an object';
    if (b.businessName != null && (typeof b.businessName !== 'string' || b.businessName.length > 200)) return 'businessName invalid';
    if (b.connectors != null && !Array.isArray(b.connectors)) return 'connectors must be an array';
    if (b.maxSteps != null && (!Number.isInteger(b.maxSteps) || b.maxSteps < 1 || b.maxSteps > 1000)) return 'maxSteps out of range';
    if (b.maxCostUsd != null && (!Number.isFinite(Number(b.maxCostUsd)) || Number(b.maxCostUsd) <= 0)) return 'maxCostUsd invalid';
    return null;
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/pricing/calculate') {
        try {
          return sendJson(res, 200, price(Object.fromEntries(url.searchParams)));
        } catch (e) {
          return sendJson(res, 400, { error: 'invalid_pricing_input', message: e.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/tenants') {
        if (!requireAdmin(req, res)) return;
        const b = await readJsonBody(req);
        const invalid = validCreate(b);
        if (invalid) return sendJson(res, 400, { error: 'invalid_tenant', message: invalid });
        const t = {
          id: 'tn_' + crypto.randomBytes(8).toString('hex'),
          businessName: b.businessName || 'My Business',
          stage: b.stage || 'new',
          industry: b.industry || 'other',
          objective: typeof b.objective === 'string' ? b.objective.slice(0, 2000) : '',
          profile: b.profile || 'repo-triage',
          connectors: Array.isArray(b.connectors) ? b.connectors.slice(0, 20) : ['web'],
          policy: b.policy || 'standard',
          maxSteps: b.maxSteps || 50,
          maxCostUsd: b.maxCostUsd || 5,
          status: 'created',
          connected: [],
          endpoint: null,
          endpointStatus: 'unconfigured',
          agentCard: null,
          discovery: null,
          createdAt: new Date().toISOString(),
        };
        store.putTenant(t);
        return sendJson(res, 201, publicTenant(t));
      }

      const tenantId = parts[2];
      const isTenantRoute = parts[0] === 'api' && parts[1] === 'tenants' && tenantId;
      if (isTenantRoute && !isValidTenantId(tenantId)) {
        return sendJson(res, 404, { error: 'tenant_not_found' });
      }

      if (req.method === 'POST' && isTenantRoute && parts[3] === 'connect') {
        if (!tenantAuthorized(req, res, tenantId)) return;
        const t = store.getTenant(tenantId);
        if (!t) return sendJson(res, 404, { error: 'tenant_not_found' });
        const b = await readJsonBody(req);
        const system = typeof b.system === 'string' ? b.system : 'shopify';
        if (!t.connected.includes(system)) t.connected.push(system);
        t.status = 'connected';
        store.putTenant(t);
        return sendJson(res, 200, {
          tenantId: t.id, system, oauth: 'mock',
          note: 'Real version: redirect owner to provider OAuth, store token encrypted per tenant, never log it.',
          next: 'POST /api/tenants/' + t.id + '/provision',
        });
      }

      if (req.method === 'POST' && isTenantRoute && parts[3] === 'provision') {
        if (!requireAdmin(req, res)) return;
        const t = store.getTenant(tenantId);
        if (!t) return sendJson(res, 404, { error: 'tenant_not_found' });
        if (t.status === 'provisioned' || t.status === 'discovered' || t.status === 'paid' || t.status === 'ready') {
          // Provisioning twice used to silently rotate the token and
          // lock the owner out. Once means once; rotation is a
          // separate, explicit, admin-only decision (not built here).
          return sendJson(res, 409, { error: 'already_provisioned' });
        }
        const plaintext = crypto.randomBytes(32).toString('hex');
        const base = (process.env.APE_PUBLIC_BASE_URL || '').replace(/\/$/, '');
        t.tokenHash = hashToken(plaintext);
        t.endpoint = base ? base + '/tenants/' + t.id + '/mcp' : null;
        t.endpointStatus = base ? 'configured' : 'unconfigured';
        t.agentCard = {
          name: 'ape-mcp', business: t.businessName, description: t.objective, version: '1.0.0',
          url: t.endpoint,
          skills: [{ id: t.profile, name: t.profile, description: t.objective, tags: ['agent', 'ape'] }],
          connectors: t.connected, capabilities: { streaming: false, pushNotifications: false },
        };
        t.status = 'provisioned';
        store.putTenant(t);
        return sendJson(res, 200, {
          ...publicTenant(t), bearerToken: plaintext,
          warning: 'Save this token now. Only its hash is stored; it cannot be shown again.',
        });
      }

      if (req.method === 'POST' && isTenantRoute && parts[3] === 'discover') {
        if (!tenantAuthorized(req, res, tenantId)) return;
        const t = store.getTenant(tenantId);
        if (!t) return sendJson(res, 404, { error: 'tenant_not_found' });
        if (t.status !== 'provisioned' && t.status !== 'paid' && t.status !== 'ready') {
          return sendJson(res, 409, { error: 'provision_first' });
        }
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
        store.putTenant(t);
        return sendJson(res, 200, publicTenant(t));
      }

      if (req.method === 'GET' && isTenantRoute && !parts[3]) {
        if (!tenantAuthorized(req, res, tenantId)) return;
        const t = store.getTenant(tenantId);
        if (!t) return sendJson(res, 404, { error: 'tenant_not_found' });
        return sendJson(res, 200, publicTenant(t));
      }

      return sendJson(res, 404, {
        error: 'not_found',
        routes: ['POST /api/tenants', 'POST /api/tenants/:id/connect', 'POST /api/tenants/:id/provision', 'POST /api/tenants/:id/discover', 'GET /api/tenants/:id', 'GET /api/pricing/calculate', 'GET /healthz'],
      });
    } catch (e) {
      if (e && e.code === 'bad_json') return sendJson(res, 400, { error: 'bad_json' });
      if (e && e.code === 'payload_too_large') return sendJson(res, 413, { error: 'payload_too_large' });
      return sendJson(res, 500, { error: 'internal_error' });
    }
  });
}

const store = createStore();
const server = createServerWithStore(store);

if (require.main === module) {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !process.env.APE_API_TOKEN) {
    console.error('refusing to bind ' + HOST + ' without APE_API_TOKEN set');
    process.exit(1);
  }
  if (!process.env.APE_API_TOKEN) {
    console.error('WARNING: APE_API_TOKEN unset — unauthenticated prototype mode, loopback only.');
  }
  server.listen(PORT, HOST, () => console.log('APE provisioning on http://' + HOST + ':' + PORT));
}

module.exports = { server, price, RATES, createServerWithStore };
