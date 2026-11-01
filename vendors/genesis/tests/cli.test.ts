/**
 * The CLI surface — argument parsing, exit codes, and clean-error behavior on
 * malformed input. `src/cli/main.ts` is otherwise untested: everything below
 * it (probe suites, verifier adapters, audit findings) has its own test file,
 * but nothing previously exercised the wiring a user actually invokes.
 */

import { describe, expect, it, vi } from "vitest";

import { AUDIT_EXIT } from "../src/assurance/audit.js";
import { main } from "../src/cli/main.js";

/** Captures stdout/stderr written during one `main()` call. */
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("genesis audit", () => {
  it("runs a probe suite against a verifier and exits with a known audit code", async () => {
    const cap = capture();
    const code = await main([
      "audit",
      "--suite", "json",
      "--verifier", "node -e process.exit(0) {task_file} {completion_file}",
      "--accept", "exit_zero",
      "--json",
    ]);
    cap.restore();
    expect([0, 1, 2]).toContain(code);
    expect(() => JSON.parse(cap.stdout())).not.toThrow();
  });

  it("fails cleanly on an unknown suite rather than crashing", async () => {
    const cap = capture();
    const code = await main(["audit", "--suite", "nope", "--verifier", "x {task_file} {completion_file}"]);
    cap.restore();
    expect(code).toBe(AUDIT_EXIT.INTERNAL_ERROR);
    expect(cap.stderr()).toContain("unknown suite");
  });
});

describe("genesis suites", () => {
  it("lists the registered probe suites and their defect classes", async () => {
    const cap = capture();
    const code = await main(["suites"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.stdout()).toContain("json@");
    expect(cap.stdout()).toContain("code@");
  });
});

describe("genesis help / version / unknown command", () => {
  it("prints usage on --help and on no arguments", async () => {
    for (const argv of [["--help"], []]) {
      const cap = capture();
      const code = await main(argv);
      cap.restore();
      expect(code).toBe(0);
      expect(cap.stdout()).toContain("genesis");
    }
  });

  it("fails cleanly on an unknown command rather than crashing", async () => {
    const cap = capture();
    const code = await main(["frobnicate"]);
    cap.restore();
    expect(code).toBe(AUDIT_EXIT.INTERNAL_ERROR);
    expect(cap.stderr()).toContain('unknown command "frobnicate"');
  });
});
