#!/usr/bin/env node
// Baseline: buggy — treats every comparison as >= (fails <, <=, ==, != cases).
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { threshold, observed } = task.input;
process.stdout.write(JSON.stringify({ passed: observed >= threshold }));
