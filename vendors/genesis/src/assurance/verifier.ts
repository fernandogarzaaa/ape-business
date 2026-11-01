/**
 * The verifier under test.
 *
 * Genesis invokes an arbitrary verifier as a subprocess: it writes the task and
 * the candidate completion to files, substitutes their paths into a declared
 * command template, and reads back a verdict. This is deliberately the dumbest
 * integration that could work — verifiers in the wild are Python scripts, shell
 * pipelines, and Makefile targets, and requiring them to implement an interface
 * would mean auditing only the verifiers that already care about being audited.
 *
 * Note the inversion relative to the acceptance layer: there, Genesis ran a
 * repository's checks to judge a change. Here the check *is* the subject, and
 * the completions are instruments. Same runner, opposite direction.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../shared/redact.js";
import type { Runner } from "../evidence/runner.js";
import type { Probe } from "./probe.js";

/** How to read accept/reject out of what the verifier emitted. */
export type AcceptRule =
  /** Exit status zero means accept. */
  | { readonly kind: "exit_zero" }
  /** Parse stdout as JSON and threshold a numeric reward field. */
  | { readonly kind: "json_reward"; readonly field?: string; readonly threshold?: number }
  /** Parse stdout as JSON and read a boolean field. */
  | { readonly kind: "json_pass"; readonly field?: string };

export interface VerifierConfig {
  readonly name: string;
  /**
   * Command template. `{task_file}` and `{completion_file}` are replaced with
   * paths to JSON and raw-text files respectively.
   */
  readonly command: readonly string[];
  readonly accept: AcceptRule;
  /**
   * Wall-clock bound on the verifier itself. A verifier that exceeds it has
   * failed to return a verdict, which for an exploit probe is a finding rather
   * than an infrastructure problem — see `missing_timeouts`.
   */
  readonly timeout_ms: number;
  readonly cwd?: string;
}

export type Observed = "accept" | "reject" | "unresponsive" | "error";

export interface VerifierResponse {
  readonly observed: Observed;
  readonly exit_code: number | null;
  readonly raw_reward: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
  readonly note: string | null;
}

/**
 * A Judge fires probes at some oracle and reports what it decided. Two
 * implementations exist: `VerifierAdapter` here, for RLVR-style verifiers
 * judging an agent-submitted completion, and `EveOracleAdapter` for EVE's
 * behavioral oracle, whose "completion" is a candidate success-signal
 * configuration rather than a file an agent produced. `runAudit`,
 * `concludeAudit`, and the report renderer are written against this
 * interface and do not know or care which kind of oracle is under test.
 */
export interface Judge {
  readonly name: string;
  judge(probe: Probe): Promise<VerifierResponse>;
  /** Recorded verbatim with the ledger entry — command, accept rule, whatever identifies exactly what was invoked. */
  describe(): Record<string, unknown>;
}

export class VerifierAdapter implements Judge {
  readonly #config: VerifierConfig;
  readonly #runner: Runner;

  constructor(config: VerifierConfig, runner: Runner) {
    this.#config = config;
    this.#runner = runner;
  }

  get name(): string {
    return this.#config.name;
  }

  get config(): VerifierConfig {
    return this.#config;
  }

  describe(): Record<string, unknown> {
    return {
      command: this.#config.command,
      accept: this.#config.accept,
      timeout_ms: this.#config.timeout_ms,
    };
  }

  async judge(probe: Probe): Promise<VerifierResponse> {
    const dir = mkdtempSync(join(tmpdir(), "genesis-probe-"));
    const taskFile = join(dir, "task.json");
    const completionFile = join(dir, "completion.txt");

    try {
      writeFileSync(taskFile, JSON.stringify(probe.task, null, 2), "utf8");
      writeFileSync(completionFile, probe.completion, "utf8");

      const command = this.#config.command.map((part) =>
        part.replaceAll("{task_file}", taskFile).replaceAll("{completion_file}", completionFile),
      );

      const started = Date.now();
      const result = await this.#runner.run(command, {
        // The invoking directory, not the probe scratch dir: verifier commands
        // are written relative to the user's cwd, and task/completion paths are
        // absolute so they resolve from anywhere.
        cwd: this.#config.cwd ?? process.cwd(),
        timeoutMs: this.#config.timeout_ms,
      });
      const duration_ms = Date.now() - started;

      if (result.spawn_error) {
        return response("error", result, duration_ms, null, `failed to run verifier: ${result.spawn_error}`);
      }

      if (result.timed_out) {
        return response(
          "unresponsive",
          result,
          duration_ms,
          null,
          `verifier did not return within ${this.#config.timeout_ms}ms`,
        );
      }

      return this.#interpret(result, duration_ms);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  #interpret(
    result: { exit_code: number | null; stdout: string; stderr: string },
    duration_ms: number,
  ): VerifierResponse {
    const rule = this.#config.accept;

    if (rule.kind === "exit_zero") {
      return response(
        result.exit_code === 0 ? "accept" : "reject",
        result,
        duration_ms,
        null,
        null,
      );
    }

    const parsed = parseJsonLoose(result.stdout);
    if (parsed === null) {
      return response("error", result, duration_ms, null, "verifier stdout was not parseable JSON");
    }

    if (rule.kind === "json_pass") {
      const field = rule.field ?? "pass";
      const value = parsed[field];
      if (typeof value !== "boolean") {
        return response("error", result, duration_ms, null, `field "${field}" was not a boolean`);
      }
      return response(value ? "accept" : "reject", result, duration_ms, null, null);
    }

    const field = rule.field ?? "reward";
    const threshold = rule.threshold ?? 1;
    const value = parsed[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return response("error", result, duration_ms, null, `field "${field}" was not a finite number`);
    }
    return response(value >= threshold ? "accept" : "reject", result, duration_ms, value, null);
  }
}

function response(
  observed: Observed,
  result: { exit_code: number | null; stdout: string; stderr: string },
  duration_ms: number,
  raw_reward: number | null,
  note: string | null,
): VerifierResponse {
  return {
    observed,
    exit_code: result.exit_code,
    raw_reward,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    duration_ms,
    note,
  };
}

/** Verifiers routinely print progress around their JSON verdict. */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  const candidates = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}
