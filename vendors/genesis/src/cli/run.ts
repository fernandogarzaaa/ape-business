/**
 * CLI entry point. Kept separate from `main.ts` so the command implementations
 * stay importable and testable without executing anything on import.
 */

import { main } from "./main.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`genesis: ${detail}\n`);
    // 3 = Genesis itself failed. Never confusable with a repository failing.
    process.exitCode = 3;
  });
