#!/usr/bin/env node
// Baseline: always returns the same two docs regardless of query.
// Well-formed output, no retrieval signal. Wrong on purpose.
import { readFileSync } from "node:fs";
readFileSync(process.argv[2], "utf8"); // accept the task file, ignore it
process.stdout.write(JSON.stringify({ retrieved_ids: ["doc-misc-1", "doc-misc-2"] }));
