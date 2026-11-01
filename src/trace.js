import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function dataDir() {
  return process.env.APE_DATA_DIR || join(process.cwd(), ".ape");
}
export function tracePath() {
  return join(dataDir(), "trace.ndjson");
}
export function ensureDataDir() {
  mkdirSync(dataDir(), { recursive: true });
}
export function newTraceId() {
  return randomUUID().slice(0, 8);
}
export function emitTrace(entry) {
  try {
    ensureDataDir();
    appendFileSync(tracePath(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* trace never breaks calls */ }
}
// Local index keys only (args hashes, trace args): 32-bit, NOT provenance.
// Anything identity-grade (outcome families/hashes, profile/env fingerprints,
// evidence digests) uses SHA-256 from outcomes.js / evidence.js.
export function shaShort(s) {
  let h = 0;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}
