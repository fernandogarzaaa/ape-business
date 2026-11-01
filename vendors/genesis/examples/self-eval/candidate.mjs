#!/usr/bin/env node
// Candidate: correct hypothesis check (mirrors src/eval/claim.ts checkHypothesis).
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { operator, threshold, observed } = task.input;
let passed = false;
switch (operator) {
  case ">=": passed = observed >= threshold; break;
  case "<=": passed = observed <= threshold; break;
  case ">": passed = observed > threshold; break;
  case "<": passed = observed < threshold; break;
  case "==": passed = observed === threshold; break;
  case "!=": passed = observed !== threshold; break;
}
process.stdout.write(JSON.stringify({ passed }));
