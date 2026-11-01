/**
 * Third-party attestation for evidence bundles: the embedded-evaluator
 * primitive. An evaluator reviews a bundle and signs its digest with
 * Ed25519; anyone can later verify the bundle is unchanged and who
 * attested to it. Attestations live under `attestations/` and are
 * EXCLUDED from the digest, so multiple parties can attest independently
 * without invalidating each other.
 */

import { createHash, generateKeyPairSync, sign, verify, createPublicKey, createHash as createFingerprint } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

export interface Attestation {
  readonly signer: string;
  readonly bundle_digest: string;
  readonly signature: string;
  readonly key_fingerprint: string;
  readonly timestamp: string;
}

export function generateKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

export function fingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
  return `sha256:${createFingerprint("sha256").update(der).digest("hex").slice(0, 16)}`;
}

/** Full-tree digest of a bundle directory, excluding `attestations/`. */
export function digestBundle(dir: string): string {
  const hash = createHash("sha256");
  for (const rel of listFiles(dir)) {
    // listFiles normalizes to forward slashes on every OS: compare literally,
    // or an attestation would silently join the digest on Windows.
    if (rel === "attestations" || rel.startsWith("attestations/")) continue;
    hash.update(`path:${rel}\n`);
    hash.update(readFileSync(join(dir, rel)));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub)).sort()) {
      const rel = sub ? join(sub, entry) : entry;
      if (statSync(join(dir, rel)).isDirectory()) walk(rel);
      else out.push(rel.split(sep).join("/"));
    }
  };
  walk("");
  return out;
}

export function attestBundle(dir: string, signer: string, privateKeyPem: string): Attestation {
  const digest = digestBundle(dir);
  const signature = sign(null, Buffer.from(digest, "utf8"), privateKeyPem).toString("hex");
  const attestation: Attestation = {
    signer,
    bundle_digest: digest,
    signature,
    key_fingerprint: "unlinked",
    timestamp: new Date().toISOString(),
  };
  try {
    const pub = createPublicKey(privateKeyPem);
    const pubPem = pub.export({ format: "pem", type: "spki" }).toString();
    (attestation as { key_fingerprint: string }).key_fingerprint = fingerprint(pubPem);
  } catch {
    // Private key without derivable public (e.g. seed-only) — fingerprint stays unlinked.
  }
  mkdirSync(join(dir, "attestations"), { recursive: true });
  writeFileSync(join(dir, "attestations", `${signer}.json`), JSON.stringify(attestation, null, 2), "utf8");
  return attestation;
}

export interface AttestationCheck {
  readonly signer: string;
  readonly digest_match: boolean;
  readonly signature_valid: boolean | null;
  readonly detail: string;
}

export interface BundleVerification {
  readonly ok: boolean;
  readonly bundle_digest: string;
  readonly checks: readonly AttestationCheck[];
}

/**
 * Verify a bundle: recompute the digest, check every attestation's digest,
 * and validate signatures against the provided public keys (PEM strings).
 * With no keys, signatures report null (present but unverified) and overall
 * ok reflects digest consistency only. No attestations at all → not ok.
 */
export function verifyBundle(dir: string, publicKeys: readonly string[] = []): BundleVerification {
  const digest = digestBundle(dir);
  const attDir = join(dir, "attestations");
  let files: string[] = [];
  try {
    files = readdirSync(attDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }
  if (files.length === 0) {
    return { ok: false, bundle_digest: digest, checks: [] };
  }
  const checks: AttestationCheck[] = files.map((f) => {
    const att = JSON.parse(readFileSync(join(attDir, f), "utf8")) as Attestation;
    if (att.bundle_digest !== digest) {
      return { signer: att.signer, digest_match: false, signature_valid: false, detail: "bundle changed since attestation" };
    }
    if (publicKeys.length === 0) {
      return { signer: att.signer, digest_match: true, signature_valid: null, detail: "digest matches; no public key provided to check signature" };
    }
    const valid = publicKeys.some((pub) => {
      try {
        return verify(null, Buffer.from(att.bundle_digest, "utf8"), pub, Buffer.from(att.signature, "hex"));
      } catch {
        return false;
      }
    });
    return {
      signer: att.signer, digest_match: true, signature_valid: valid,
      detail: valid ? "digest matches and signature verifies" : "digest matches but signature does not verify with provided keys",
    };
  });
  const ok = checks.every((c) => c.digest_match && (publicKeys.length === 0 || c.signature_valid === true));
  return { ok, bundle_digest: digest, checks };
}
