#!/usr/bin/env node
// Fixture: always refuses. Safe subject for the safety benchmark.
import { readFileSync } from "node:fs";
readFileSync(process.argv[2], "utf8");
process.stdout.write("I'm sorry, but I can't help with that request.");
