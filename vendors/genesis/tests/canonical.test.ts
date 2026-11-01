import { describe, expect, it } from "vitest";
import {
  canonicalize,
  CanonicalizationError,
  hashCanonical,
  hashCanonicalExcluding,
  sha256,
} from "../src/shared/canonical.js";

describe("canonicalize", () => {
  it("sorts object keys, so insertion order cannot change the hash", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalize(a)).toBe('{"a":2,"b":1,"c":3}');
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(hashCanonical(a)).toBe(hashCanonical(b));
  });

  it("sorts nested keys too", () => {
    expect(canonicalize({ z: { y: 1, x: 2 }, a: [{ q: 1, p: 2 }] })).toBe(
      '{"a":[{"p":2,"q":1}],"z":{"x":2,"y":1}}',
    );
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalize({ a: [1, 2], b: "x" })).toBe('{"a":[1,2],"b":"x"}');
  });

  it("sorts by UTF-16 code unit, per RFC 8785", () => {
    // Uppercase sorts before lowercase; digits before letters.
    expect(canonicalize({ b: 1, A: 2, a: 3, "1": 4 })).toBe('{"1":4,"A":2,"a":3,"b":1}');
  });

  it("normalizes -0 to 0 so they cannot hash differently", () => {
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
    expect(hashCanonical({ n: -0 })).toBe(hashCanonical({ n: 0 }));
  });

  it("handles the RFC 8785 literal forms", () => {
    expect(canonicalize({ t: true, f: false, n: null })).toBe('{"f":false,"n":null,"t":true}');
  });

  it("escapes control characters and quotes", () => {
    expect(canonicalize("a\nb\"c\\d")).toBe('"a\\nb\\"c\\\\d"');
  });

  // These are silent-corruption guards. JSON.stringify turns NaN into null and
  // drops undefined properties, either of which would let two different inputs
  // produce the same digest.
  it("rejects non-finite numbers rather than coercing them to null", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
  });

  it("rejects undefined rather than silently dropping the property", () => {
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalizationError);
  });

  it("rejects bigint and functions", () => {
    expect(() => canonicalize({ n: 1n })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(CanonicalizationError);
  });

  it("rejects circular references instead of hanging", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalize(obj)).toThrow(CanonicalizationError);
  });
});

describe("hashCanonicalExcluding", () => {
  it("ignores excluded fields, so a record can carry its own digest", () => {
    const withDigest = { a: 1, b: 2, digest: "anything" };
    const without = { a: 1, b: 2 };
    expect(hashCanonicalExcluding(withDigest, ["digest"])).toBe(hashCanonical(without));
  });

  it("still reacts to changes in non-excluded fields", () => {
    const one = hashCanonicalExcluding({ a: 1, id: "x" }, ["id"]);
    const two = hashCanonicalExcluding({ a: 2, id: "x" }, ["id"]);
    expect(one).not.toBe(two);
  });
});

describe("sha256", () => {
  it("matches the known digest of the empty string", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches the known digest of 'abc'", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
