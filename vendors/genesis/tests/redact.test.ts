import { afterEach, describe, expect, it } from "vitest";
import { clearRegisteredSecrets, redact, redactDeep, registerSecret } from "../src/shared/redact.js";

/**
 * `registerSecret` adds to a module-level `Set` that otherwise never gets
 * cleared, so a secret registered in one test would silently leak into every
 * later test's `redact()` calls. `afterEach` here is the guard against that —
 * see src/shared/redact.ts for why `clearRegisteredSecrets` exists at all.
 */
afterEach(() => {
  clearRegisteredSecrets();
});

describe("registerSecret / redact", () => {
  it("redacts an exact-match registered secret", () => {
    registerSecret("super-secret-value");
    expect(redact("token=super-secret-value end")).toBe("token=[REDACTED] end");
  });

  it("ignores short values, which would redact half the log", () => {
    registerSecret("short");
    expect(redact("this is short and stays visible")).toContain("short");
  });

  it("does not redact a value that was never registered", () => {
    expect(redact("token=totally-unregistered-value")).toContain("totally-unregistered-value");
  });
});

describe("clearRegisteredSecrets", () => {
  it("stops redacting a value once cleared", () => {
    registerSecret("clear-me-please");
    expect(redact("clear-me-please")).toBe("[REDACTED]");

    clearRegisteredSecrets();
    expect(redact("clear-me-please")).toBe("clear-me-please");
  });

  it("keeps registrations isolated between tests (regression guard for the leak this fixes)", () => {
    // If a prior test's afterEach failed to run, this value would already be
    // registered and this assertion would fail — that is the point of the test.
    expect(redact("super-secret-value")).toContain("super-secret-value");
  });
});

describe("pattern-based redaction", () => {
  it("redacts a GitHub token without registration", () => {
    expect(redact(`Authorization: ghp_${"a".repeat(36)}`)).toBe("Authorization: [REDACTED]");
  });

  it("redacts an assigned secret regardless of key case", () => {
    expect(redact('GITHUB_API_KEY="abcdef123456"')).toBe('GITHUB_API_KEY="[REDACTED]"');
  });
});

describe("redactDeep", () => {
  it("redacts strings nested in objects and arrays alike", () => {
    registerSecret("nested-secret-value");
    const out = redactDeep({ a: ["nested-secret-value", { b: "nested-secret-value" }] });
    expect(out).toEqual({ a: ["[REDACTED]", { b: "[REDACTED]" }] });
  });
});
