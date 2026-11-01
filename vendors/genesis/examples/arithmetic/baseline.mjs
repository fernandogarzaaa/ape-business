#!/usr/bin/env node
// Baseline: echoes the input unchanged (does not double). Wrong on purpose.
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const input = typeof task.input === "string" ? task.input : JSON.stringify(task.input);
process.stdout.write(input);
