// Sigil index service: the hosted badge directory the gate reads.
//
// The gate (src/agent/sigil-gate.js) consumes a directory layout:
//   badges/<server>/<version>.json   (Ed25519-signed badge)
//   revocations/<server>/<version>.json (signed by the project key)
//   keys/project.json                (project public key)
// This service publishes into that layout with verification at the
// door: a badge that does not verify is never written, a revocation
// not signed by the current project key is never written. Private
// keys NEVER touch this service's storage: publishers sign locally
// (sign.mjs) and submit signed objects; rotation generates the new
// project keypair here, returns the private key ONCE to the admin,
// archives the old public key, and re-signs nothing implicitly —
// outstanding revocations must be re-issued under the new key, and
// the gate failing closed on unverifiable revocations is the
// intended pressure to do so promptly.
//
// Endpoints (admin = Bearer SIGIL_INDEX_ADMIN_TOKEN, env name only):
//   POST /admin/badges        {badge}                  -> verified write
//   POST /admin/revocations   {revocation}             -> verified write
//   POST /admin/keys/rotate   {}                       -> new project key (private shown once)
//   GET  /badges/:server/:version
//   GET  /revocations/:server/:version
//   GET  /keys/project.json
//   GET  /healthz
// Env: SIGIL_INDEX_DIR, SIGIL_INDEX_PORT, SIGIL_INDEX_ADMIN_TOKEN, HOST.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJsonBody, sendJson, tokenMatches } = require('../lib/http');

const PORT = process.env.SIGIL_INDEX_PORT || 8792;
const HOST = process.env.HOST || '127.0.0.1';
const INDEX_DIR = process.env.SIGIL_INDEX_DIR ||
  path.join(__dirname, '..', 'data', 'sigil-index');

let gatePromise = null;
function gate() {
  if (!gatePromise) {
    gatePromise = import('../../src/agent/sigil-gate.js');
  }
  return gatePromise;
}

function adminOk(req) {
  const expected = process.env.SIGIL_INDEX_ADMIN_TOKEN || '';
  if (!expected) return false;
  const auth = req.headers.authorization || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return tokenMatches(provided, expected);
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function createIndexServer(indexDir) {
  const dir = indexDir || INDEX_DIR;
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const g = await gate();
      const seg = (v) => g.sanitizeSegment(v || '');

      if (req.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && parts[0] === 'keys' && parts[1] === 'project.json') {
        const key = g.loadProjectKey(dir);
        if (!key) return sendJson(res, 404, { error: 'no_project_key' });
        return sendJson(res, 200, key);
      }
      if (req.method === 'GET' && (parts[0] === 'badges' || parts[0] === 'revocations')) {
        const file = path.join(dir, parts[0], seg(parts[1]), seg(parts[2]) + '.json');
        if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not_found' });
        return sendJson(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
      }
      if (req.method === 'POST' && parts[0] === 'admin') {
        if (!adminOk(req)) return sendJson(res, 401, { error: 'unauthorized' });
        const b = await readJsonBody(req);
        if (parts[1] === 'badges') {
          const badge = b.badge || b;
          const v = g.verifyBadge(badge);
          if (!v.ok) return sendJson(res, 400, { error: 'badge_does_not_verify', detail: v.reason });
          if (badge.server !== b.server && b.server && badge.server !== b.server) {
            return sendJson(res, 400, { error: 'badge_mismatch' });
          }
          const file = path.join(dir, 'badges', seg(badge.server), seg(badge.version) + '.json');
          writeJson(file, badge);
          return sendJson(res, 201, { published: true, server: badge.server, version: badge.version, keyId: badge.keyId });
        }
        if (parts[1] === 'revocations') {
          const revocation = b.revocation || b;
          const projectKey = g.loadProjectKey(dir);
          if (!projectKey) return sendJson(res, 409, { error: 'no_project_key_to_pin_to' });
          if (revocation.server == null || revocation.version == null) {
            return sendJson(res, 400, { error: 'revocation_missing_fields' });
          }
          // Full signed-object contract, mirroring the gate: type,
          // status, key pinning, embedded key match, then signature.
          const { canonicalize } = g;
          if (revocation.type !== 'sigil-revocation/v1' || revocation.status !== 'revoked') {
            return sendJson(res, 400, { error: 'revocation_contract_invalid' });
          }
          if (!revocation.signature || !revocation.revokedAt) {
            return sendJson(res, 400, { error: 'revocation_missing_fields' });
          }
          if (revocation.keyId !== projectKey.keyId ||
              canonicalize(revocation.publicKey || {}) !== canonicalize(projectKey.publicKey)) {
            return sendJson(res, 400, { error: 'revocation_key_mismatch' });
          }
          const { signature, ...unsigned } = revocation;
          const key = crypto.createPublicKey({ key: projectKey.publicKey, format: 'jwk' });
          const ok = crypto.verify(null, Buffer.from(canonicalize(unsigned)), key, Buffer.from(signature, 'base64'));
          if (!ok) return sendJson(res, 400, { error: 'revocation_not_signed_by_project_key' });
          const file = path.join(dir, 'revocations', seg(revocation.server), seg(revocation.version) + '.json');
          writeJson(file, revocation);
          return sendJson(res, 201, { published: true, server: revocation.server, version: revocation.version, status: revocation.status });
        }
        if (parts[1] === 'keys' && parts[2] === 'rotate') {
          const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
          const pubJwk = publicKey.export({ format: 'jwk' });
          const keyId = crypto.createHash('sha256')
            .update(g.canonicalize(pubJwk)).digest('hex').slice(0, 16);
          const old = g.loadProjectKey(dir);
          if (old) {
            writeJson(path.join(dir, 'keys', 'archive', old.keyId + '.json'), old);
          }
          const current = { keyId, publicKey: pubJwk };
          writeJson(path.join(dir, 'keys', 'project.json'), current);
          return sendJson(res, 201, {
            rotated: true, keyId,
            privateKeyJwk: privateKey.export({ format: 'jwk' }),
            warning: 'Store this private key in Secure Vault NOW. It is shown once and never stored here. Re-issue outstanding revocations under the new key; the gate fails closed on unverifiable revocations.',
            previousKeyId: old ? old.keyId : null,
          });
        }
        return sendJson(res, 404, { error: 'not_found' });
      }
      return sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e.code === 'bad_json') return sendJson(res, 400, { error: 'bad_json' });
      if (e.code === 'payload_too_large') return sendJson(res, 413, { error: 'payload_too_large' });
      return sendJson(res, 500, { error: 'internal_error' });
    }
  });
}

if (require.main === module) {
  if (!process.env.SIGIL_INDEX_ADMIN_TOKEN) {
    console.error('refusing to start: SIGIL_INDEX_ADMIN_TOKEN unset (publishing would be unauthenticated)');
    process.exit(1);
  }
  // Admin token + rotated private keys cross this listener: never
  // serve them over cleartext beyond loopback unless a TLS proxy
  // terminates in front (explicitly acknowledged).
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && process.env.SIGIL_INDEX_BEHIND_TLS !== '1') {
    console.error('refusing non-loopback bind without SIGIL_INDEX_BEHIND_TLS=1 (admin token and private keys would cross cleartext HTTP)');
    process.exit(1);
  }
  createIndexServer().listen(PORT, HOST, () =>
    console.log('Sigil index on http://' + HOST + ':' + PORT + ' dir=' + INDEX_DIR));
}

module.exports = { createIndexServer };
