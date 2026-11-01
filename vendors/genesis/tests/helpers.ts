import type { RunResult, Runner, RunOptions } from "../src/evidence/runner.js";

/** A Runner that replays canned results instead of spawning processes. */
export class FakeRunner implements Runner {
  readonly calls: Array<{ command: readonly string[]; options: RunOptions }> = [];
  readonly #responses: Map<string, Partial<RunResult>>;
  readonly #fallback: Partial<RunResult>;

  constructor(responses: Record<string, Partial<RunResult>> = {}, fallback: Partial<RunResult> = {}) {
    this.#responses = new Map(Object.entries(responses));
    this.#fallback = fallback;
  }

  run(command: readonly string[], options: RunOptions): Promise<RunResult> {
    this.calls.push({ command, options });
    const key = command.join(" ");
    const canned = this.#responses.get(key) ?? this.#fallback;
    return Promise.resolve({
      command,
      exit_code: 0,
      stdout: "",
      stderr: "",
      started_at: "2026-08-02T00:00:00.000Z",
      ended_at: "2026-08-02T00:00:01.000Z",
      timed_out: false,
      spawn_error: null,
      ...canned,
    });
  }
}
