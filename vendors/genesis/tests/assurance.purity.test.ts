/**
 * `findings.ts` is the assurance module's pure core, and it is held to the same
 * standard as the adjudicator.
 *
 * The reason is sharper here than it was there. This module's product is a
 * claim about whether someone else's verifier can be trusted. If the claim
 * cannot be recomputed from the recorded probe results — if it depends on a
 * clock, a config file, or the order the probes happened to finish in — then an
 * assurance tool is asking for trust it will not extend to anyone else.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FINDINGS = fileURLToPath(new URL("../src/assurance/findings.ts", import.meta.url));

const ALLOWED_IMPORTS = [
  "../backtest/metrics.js",
  "./probe.js",
  "./taxonomy.js",
  "./behavioral-taxonomy.js",
  "./verifier.js",
];

const FORBIDDEN = [
  /\bDate\.now\s*\(/,
  /\bnew\s+Date\s*\(/,
  /\bMath\.random\s*\(/,
  /\bperformance\.now\s*\(/,
  /\bprocess\.(env|argv|cwd)\b/,
  /\brequire\s*\(/,
  /\bfetch\s*\(/,
  /\bglobalThis\b/,
];

describe("assurance findings purity", () => {
  const source = readFileSync(FINDINGS, "utf8");

  it("imports no Node built-ins", () => {
    const nodeImports = [...source.matchAll(/from\s+["'](node:[^"']+)["']/g)].map((m) => m[1]);
    expect(nodeImports).toEqual([]);
  });

  it("imports only from the allowed surface", () => {
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    expect(imports.filter((spec) => !ALLOWED_IMPORTS.includes(spec))).toEqual([]);
  });

  it("touches no clock, randomness, or ambient state", () => {
    expect(FORBIDDEN.filter((re) => re.test(source)).map((re) => re.source)).toEqual([]);
  });

  it("imports runtime values only from pure modules", () => {
    // Three: `wilson` (a statistical function, deliberately reused rather
    // than reimplemented) and the two frozen taxonomy tables. All pure;
    // everything else this module needs is a type.
    const valueImports = [...source.matchAll(/^import\s+(?!type\b)([^;]+?)\s+from\s+["']([^"']+)["']/gm)].map(
      (m) => m[2],
    );
    expect(valueImports.sort()).toEqual([
      "../backtest/metrics.js",
      "./behavioral-taxonomy.js",
      "./taxonomy.js",
    ]);
  });
});
