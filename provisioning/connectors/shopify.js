// Shopify connector: OAuth first (Phase 1 item 1), read-only scope.
// Flow: buildAuthUrl -> merchant approves on Shopify -> callback
// (HMAC-verified, state-signed) -> code exchange -> access token
// encrypted into the tenant vault (lib/vault.js). Token plaintext
// never touches disk, logs, or responses.
//
// Env names only: SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET,
// SHOPIFY_REDIRECT_URI, APE_VAULT_KEY. The HTTPS exchange is behind
// an injectable transport so tests never contact Shopify.
'use strict';

const crypto = require('crypto');
const https = require('https');

const SCOPES = 'read_products,read_orders,read_customers';

function signState(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyState(state, secret, maxAgeMs) {
  const parts = String(state || '').split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
  if (!payload.tenantId || !payload.shop || !payload.exp) return null;
  if (Date.now() > payload.exp + (maxAgeMs || 10 * 60 * 1000)) return null;
  return payload;
}

function validShop(shop) {
  return typeof shop === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

function buildAuthUrl({ shop, clientId, redirectUri, state }) {
  if (!validShop(shop)) throw new Error('shop must be a *.myshopify.com domain');
  if (!clientId) throw new Error('SHOPIFY_CLIENT_ID is not configured');
  const q = new URLSearchParams({
    client_id: clientId, scope: SCOPES, redirect_uri: redirectUri, state,
  });
  return `https://${shop}/admin/oauth/authorize?${q.toString()}`;
}

// Shopify callback HMAC: every query param except hmac/signature,
// "key=value" with & and % escaped per Shopify docs, &-joined, HMAC-SHA256 hex.
function verifyCallbackHmac(query, secret) {
  if (!query || !query.hmac || !secret) return false;
  const pairs = Object.entries(query)
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .map(([k, v]) => `${k.replace(/%/g, '%25').replace(/&/g, '%26').replace(/=/g, '%3D')}=${String(v).replace(/%/g, '%25').replace(/&/g, '%26')}`)
    .sort()
    .join('&');
  const expected = crypto.createHmac('sha256', secret).update(pairs).digest('hex');
  const a = Buffer.from(String(query.hmac));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function defaultPost(shop, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: shop, path: '/admin/oauth/access_token', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(s); } catch { parsed = {}; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error('Shopify token exchange failed: ' + res.statusCode);
          e.statusCode = res.statusCode;
          return reject(e);
        }
        resolve(parsed);
      });
    });
    // The timeout option alone never aborts; destroy the socket so
    // a stalled exchange cannot hang the callback forever.
    req.on('timeout', () => req.destroy(new Error('Shopify token exchange timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function exchangeCode({ shop, code, clientId, clientSecret }, deps) {
  if (!validShop(shop)) throw new Error('invalid shop domain');
  if (!clientId || !clientSecret) throw new Error('Shopify client credentials are not configured');
  const post = (deps && deps.post) || defaultPost;
  const out = await post(shop, JSON.stringify({
    client_id: clientId, client_secret: clientSecret, code,
  }));
  if (!out || !out.access_token) throw new Error('Shopify exchange returned no access_token');
  // Granted scopes must cover what was requested; a downgraded
  // token must not be stored as a full connection.
  const granted = new Set(String(out.scope || '').split(',').map((x) => x.trim()).filter(Boolean));
  const missing = SCOPES.split(',').filter((x) => !granted.has(x));
  if (missing.length) {
    const e = new Error('Shopify granted scopes missing: ' + missing.join(','));
    e.code = 'insufficient_scope';
    throw e;
  }
  return { accessToken: out.access_token, scope: out.scope || SCOPES };
}

module.exports = {
  SCOPES, signState, verifyState, validShop, buildAuthUrl,
  verifyCallbackHmac, exchangeCode,
};
