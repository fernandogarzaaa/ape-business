/**
 * Type declarations for genesis-adapter (Node).
 * Mirrors index.js; kept handwritten so the package stays dependency-free.
 */

export interface GenesisTask {
  id: string;
  input: unknown;
  context?: unknown;
  expected?: unknown;
  reference?: unknown;
  constraints?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tags?: string[];
  kind?: string;
  evaluation_instructions?: string;
  [key: string]: unknown;
}

export type SubjectFn = (task: GenesisTask) => unknown | Promise<unknown>;
export type EvaluatorFn = (
  task: GenesisTask,
  output: unknown,
) => boolean | number | Record<string, unknown> | Promise<boolean | number | Record<string, unknown>>;

export function loadTask(path?: string): GenesisTask;
export function loadOutput(path?: string): { value: unknown; raw: string };
export function formatOutput(value: unknown): string;
export function formatVerdict(value: boolean | number | Record<string, unknown>): string;
export function runSubject(fn: SubjectFn): Promise<void>;
export function runEvaluator(fn: EvaluatorFn): Promise<void>;
