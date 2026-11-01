/**
 * Secret redaction for evidence artifacts.
 *
 * Genesis stores raw collector output — test logs, CI logs, scanner reports —
 * as evidence blobs, and those routinely contain tokens. Redaction must happen
 * *before* the blob is written and *before* its digest is computed, or the
 * digest certifies an artifact that no longer matches what is stored.
 *
 * Extends v1's registered-value redaction (`kernel/security/secret-store.ts`)
 * with pattern matching, because Genesis reads logs from repositories whose
 * secrets it was never told about.
 */

export const REDACTED = "[REDACTED]";

const registered = new Set<string>();

/** Register a known secret value for exact-match redaction. */
export function registerSecret(value: string): void {
  // Very short values would redact half the log.
  if (value.length >= 8) registered.add(value);
}

export function clearRegisteredSecrets(): void {
  registered.clear();
}

/**
 * Patterns for credentials Genesis was never told about. Deliberately
 * conservative — a false positive costs a few characters of a log, a false
 * negative writes a live token into the ledger permanently.
 */
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "private-key-block", re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Assignments like AUTH_TOKEN=..., api_key: "...", PASSWORD = '...'
  {
    name: "assigned-secret",
    re: /\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"'&]{6,})\3/gi,
  },
];

/** Redact registered secrets and recognizable credential patterns. */
export function redact(text: string): string {
  let out = text;

  for (const secret of registered) {
    out = out.split(secret).join(REDACTED);
  }

  for (const { re, name } of PATTERNS) {
    re.lastIndex = 0;
    out =
      name === "assigned-secret"
        ? out.replace(re, (_m, key: string, sep: string, quote: string) => `${key}${sep}${quote}${REDACTED}${quote}`)
        : out.replace(re, REDACTED);
  }

  return out;
}

/** Redact every string in a JSON-ish structure, in place of the original. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}
