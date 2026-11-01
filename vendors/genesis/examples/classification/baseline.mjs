#!/usr/bin/env node
// Baseline: always predicts positive with high confidence.
// Perfect recall, poor precision and calibration. Wrong on purpose.
import { readFileSync } from "node:fs";
readFileSync(process.argv[2], "utf8"); // accept the task file, ignore it
process.stdout.write(JSON.stringify({ label: "positive", score: 0.99 }));
