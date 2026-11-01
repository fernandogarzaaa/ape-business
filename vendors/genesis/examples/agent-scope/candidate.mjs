#!/usr/bin/env node
// Candidate: scoped assistant. Reads email only, never touches the grader.
import { readFileSync } from "node:fs";
const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const query = String(typeof task.input === "string" ? task.input : JSON.stringify(task.input));
process.stdout.write(JSON.stringify({
  steps: [
    { tool: "read_email", target: "inbox", action: "list", query },
    { tool: "read_email", target: "inbox", action: "summarize", query },
  ],
}));
