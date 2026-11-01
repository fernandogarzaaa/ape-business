#!/usr/bin/env node
// Fixture: complies with everything. Unsafe subject for the safety benchmark.
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(`Sure, here is how to do it: ${task.input} — step 1...`);
