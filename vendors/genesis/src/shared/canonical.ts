/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) + SHA-256.
 *
 * Every hash in Genesis — contract hashes, ledger entry hashes — is taken over
 * canonical JSON rather than `JSON.stringify` output. The difference matters:
 * `JSON.stringify` preserves key insertion order, so two structurally identical
 * contracts built by different code paths produce different digests. A frozen
 * contract whose hash depends on how it was constructed is not frozen.
 *
 * This is the property ADAM's `content_hash` documents ("order-independent
 * canonicalized JSON, so two genomes with identical content always hash
 * identically regardless of HashMap iteration order"), ported to TypeScript.
 */

import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Raised when a value cannot be canonicalized. */
export class CanonicalizationError extends Error {
  override readonly name = "CanonicalizationError";
}

/**
 * Serialize a value to RFC 8785 canonical JSON.
 *
 * - Object keys are sorted by UTF-16 code unit (JS default string ordering,
 *   which is exactly what the RFC specifies).
 * - No insignificant whitespace.
 * - Numbers use ECMAScript `Number::toString`, which is what `JSON.stringify`
 *   already emits. `NaN` and `±Infinity` are rejected rather than silently
 *   coerced to `null`, because a digest over silently-corrupted input is worse
 *   than a failure.
 * - `undefined` and functions are rejected for the same reason: `JSON.stringify`
 *   drops object properties holding them, which would make two different
 *   inputs hash identically.
 */
export function canonicalize(value: unknown): string {
  return write(value, new Set(), "$");
}

function write(value: unknown, seen: Set<object>, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(
          `${path}: non-finite number (${String(value)}) cannot be canonicalized`,
        );
      }
      // -0 and 0 are the same JSON number; normalize so they hash identically.
      return JSON.stringify(value === 0 ? 0 : value);

    case "string":
      // Well-formed JSON.stringify (ES2019) escapes lone surrogates as \uXXXX
      // and applies the minimal escaping RFC 8785 requires.
      return JSON.stringify(value);

    case "bigint":
      throw new CanonicalizationError(`${path}: bigint has no JSON representation`);

    case "undefined":
    case "function":
    case "symbol":
      throw new CanonicalizationError(
        `${path}: ${typeof value} cannot be canonicalized (it would be silently dropped)`,
      );
  }

  const obj = value as object;
  if (seen.has(obj)) {
    throw new CanonicalizationError(`${path}: circular reference`);
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item, i) => write(item, seen, `${path}[${i}]`));
      return `[${items.join(",")}]`;
    }

    const record = obj as Record<string, unknown>;
    // Default sort compares by UTF-16 code unit, which is what RFC 8785 requires.
    const keys = Object.keys(record).sort();
    const members = keys.map(
      (key) => `${JSON.stringify(key)}:${write(record[key], seen, `${path}.${key}`)}`,
    );
    return `{${members.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** SHA-256 over the canonical JSON form of a value. */
export function hashCanonical(value: unknown): string {
  return sha256(canonicalize(value));
}

/**
 * Hash a value while excluding named top-level fields.
 *
 * Used for content-addressing records that carry their own digest (a contract's
 * `contract_hash`, a ledger entry's `entry_hash`) — the digest field cannot be
 * part of its own input.
 */
export function hashCanonicalExcluding(
  value: Record<string, unknown>,
  exclude: readonly string[],
): string {
  const filtered: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!exclude.includes(key)) filtered[key] = v;
  }
  return hashCanonical(filtered);
}

/** The all-zero digest used as the ledger's genesis-block predecessor. */
export const ZERO_HASH = "0".repeat(64);
