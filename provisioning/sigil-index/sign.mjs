#!/usr/bin/env node
// Local Sigil signing tool. Private keys stay on YOUR machine/Vault;
// only signed objects are submitted to the index service.
//
// Usage:
//   node sign.mjs badge --server <name> --version <v> --score <0-100> --level <low|medium|high|critical> --key <privJwkFile>
//   node sign.mjs keygen --out <privJwkFile>            (prints public key json for keys/project.json)
//   node sign.mjs revocation --server <name> --version <v> --reason <text> --key <projectPrivJwkFile>
//
// Output is the signed JSON object on stdout. Env names only for the
// admin token when posting: SIGIL_INDEX_ADMIN_TOKEN (never a key).
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalize } from '../../src/agent/sigil-gate.js';

function keyIdOf(pubJwk) {
  return createHash('sha256').update(canonicalize(pubJwk)).digest('hex').slice(0, 16);
}

function signObject(unsigned, privJwk) {
  const key = createPrivateKey({ key: privJwk, format: 'jwk' });
  const signature = sign(null, Buffer.from(canonicalize(unsigned)), key).toString('base64');
  return { ...unsigned, signature };
}

const [cmd, ...rest] = process.argv.slice(2);
const arg = (name) => {
  const i = rest.indexOf('--' + name);
  return i >= 0 ? rest[i + 1] : null;
};

if (cmd === 'keygen') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const out = arg('out');
  if (out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, JSON.stringify(priv), { mode: 0o600 });
    console.error('private key written (0600) to ' + out + ' — move it to Secure Vault');
  } else {
    console.log(JSON.stringify(priv));
  }
  console.log(JSON.stringify({ keyId: keyIdOf(pub), publicKey: pub }));
} else if (cmd === 'badge') {
  const priv = JSON.parse(readFileSync(arg('key'), 'utf8'));
  const pub = { crv: 'Ed25519', kty: 'OKP', x: priv.x };
  const badge = signObject({
    type: 'sigil-badge/v1',
    server: arg('server'), version: arg('version'),
    riskScore: Number(arg('score')), riskLevel: arg('level'),
    keyId: keyIdOf(pub), publicKey: pub,
    issuedAt: new Date().toISOString(),
  }, priv);
  console.log(JSON.stringify(badge, null, 2));
} else if (cmd === 'revocation') {
  const priv = JSON.parse(readFileSync(arg('key'), 'utf8'));
  const pub = { crv: 'Ed25519', kty: 'OKP', x: priv.x };
  const revocation = signObject({
    type: 'sigil-revocation/v1',
    server: arg('server'), version: arg('version'),
    status: 'revoked', reason: arg('reason') || 'revoked by maintainer',
    revokedAt: new Date().toISOString(),
    keyId: keyIdOf(pub), publicKey: pub,
  }, priv);
  console.log(JSON.stringify(revocation, null, 2));
} else {
  console.error('usage: sign.mjs <keygen|badge|revocation> [flags]');
  process.exit(2);
}
