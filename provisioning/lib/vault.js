// Per-tenant credential vault: AES-256-GCM at rest.
// Key: APE_VAULT_KEY (env name only; 32 bytes as hex or base64, from
// Secure Vault). Ciphertext format: v1.<iv>.<tag>.<data> (base64url).
// Production replaces this envelope with one Secrets Manager secret
// per tenant (SECURITY.md); the encrypt/decrypt API stays the same.
'use strict';

const crypto = require('crypto');

function vaultKey() {
  const raw = process.env.APE_VAULT_KEY || '';
  if (!raw) {
    const e = new Error('APE_VAULT_KEY is not configured; refusing to store credentials');
    e.code = 'missing_vault_key';
    throw e;
  }
  let key;
  if (/^[a-f0-9]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    const e = new Error('APE_VAULT_KEY must decode to 32 bytes');
    e.code = 'bad_vault_key';
    throw e;
  }
  return key;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b) => b.toString('base64url');
  return ['v1', b64(iv), b64(tag), b64(data)].join('.');
}

function decrypt(envelope) {
  const parts = String(envelope || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('bad credential envelope');
  const dec = (s) => Buffer.from(s, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), dec(parts[1]));
  decipher.setAuthTag(dec(parts[2]));
  return Buffer.concat([decipher.update(dec(parts[3])), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
