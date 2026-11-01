#!/usr/bin/env node
// Candidate: doubles numeric input. Correct implementation under test.
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const raw = typeof task.input === "string" ? task.input : JSON.stringify(task.input);
const n = Number(raw);
process.stdout.write(Number.isFinite(n) ? String(n * 2) : raw);
