/**
 * Subprocess execution for collectors.
 *
 * Genesis never authors, modifies, or repairs anything in the repository. It
 * does execute the repository's *own declared* verification commands, in order
 * to observe their results firsthand rather than take the executor's word for
 * them. That is the precise meaning of "Genesis does not execute": no write
 * path to the working tree, and no commands it invented.
 *
 * MVP posture: subprocess, scrubbed environment, wall-clock timeout. Adequate
 * for a locally-run CLI on the user's own code. Container isolation is a hard
 * prerequisite before this ever runs as a hosted service against arbitrary
 * verifiers.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../shared/redact.js";

export interface RunResult {
  readonly command: readonly string[];
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly timed_out: boolean;
  readonly spawn_error: string | null;
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

export interface Runner {
  run(command: readonly string[], options: RunOptions): Promise<RunResult>;
}

/** Environment variables a verification command legitimately needs. */
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "SHELL", "TERM"];

export class SubprocessRunner implements Runner {
  readonly #defaultTimeoutMs: number;

  constructor(defaultTimeoutMs = 10 * 60_000) {
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  run(command: readonly string[], options: RunOptions): Promise<RunResult> {
    const started_at = new Date().toISOString();
    const [bin, ...args] = command;

    if (!bin) {
      return Promise.resolve({
        command, exit_code: null, stdout: "", stderr: "",
        started_at, ended_at: started_at, timed_out: false,
        spawn_error: "empty command",
      });
    }

    const env: Record<string, string> = { CI: "1", NO_COLOR: "1" };
    for (const key of ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, options.env ?? {});

    return new Promise<RunResult>((resolve) => {
      const child = spawn(bin, args, {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs ?? this.#defaultTimeoutMs);

      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

      const finish = (exit_code: number | null, spawn_error: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          command,
          exit_code,
          // Redact at the boundary: everything downstream — artifacts, digests,
          // ledger payloads — reads from here.
          stdout: redact(stdout),
          stderr: redact(stderr),
          started_at,
          ended_at: new Date().toISOString(),
          timed_out: timedOut,
          spawn_error,
        });
      };

      child.on("error", (err) => finish(null, err.message));
      child.on("close", (code) => finish(code, null));
    });
  }
}

/**
 * Digest of the execution environment — what "the same inputs" means when a
 * verdict is replayed. Runtime version, platform, and the dependency lockfile.
 */
export function computeEnvDigest(repoPath: string): string {
  const hash = createHash("sha256");
  hash.update(`node:${process.version}\n`);
  hash.update(`platform:${process.platform}-${process.arch}\n`);

  for (const lockfile of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock", "uv.lock"]) {
    try {
      const content = readFileSync(join(repoPath, lockfile));
      hash.update(`${lockfile}:${createHash("sha256").update(content).digest("hex")}\n`);
    } catch {
      // Absent lockfiles are normal; only present ones contribute.
    }
  }

  return `sha256:${hash.digest("hex")}`;
}
