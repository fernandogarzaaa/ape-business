#!/usr/bin/env node
// Candidate: keyword-overlap retrieval over a tiny built-in corpus.
// Returns top-2 docs by shared query terms. Deterministic, no network.
import { readFileSync } from "node:fs";

const CORPUS = [
  { id: "doc-auth-1", terms: ["reset", "password", "account", "delete"] },
  { id: "doc-auth-2", terms: ["password", "two", "factor", "authentication"] },
  { id: "doc-auth-3", terms: ["two", "factor", "authentication", "enable"] },
  { id: "doc-billing-1", terms: ["refund", "policy", "annual", "plans", "credit", "card", "update"] },
  { id: "doc-billing-2", terms: ["credit", "card", "update", "billing"] },
  { id: "doc-data-1", terms: ["export", "data", "csv"] },
  { id: "doc-data-2", terms: ["delete", "account", "permanently", "data"] },
  { id: "doc-team-1", terms: ["invite", "teammate", "workspace"] },
  { id: "doc-team-2", terms: ["change", "workspace", "owner", "teammate"] },
  { id: "doc-misc-1", terms: ["changelog", "release", "notes"] },
  { id: "doc-misc-2", terms: ["status", "uptime", "health"] },
];

const task = JSON.parse(readFileSync(process.argv[2], "utf8"));
const query = String(typeof task.input === "string" ? task.input : JSON.stringify(task.input)).toLowerCase();
const tokens = new Set(query.split(/[^a-z0-9]+/).filter(Boolean));

const ranked = CORPUS.map((d) => ({
  id: d.id,
  hits: d.terms.filter((t) => tokens.has(t)).length,
})).sort((a, b) => b.hits - a.hits || (a.id < b.id ? -1 : 1));

process.stdout.write(JSON.stringify({ retrieved_ids: ranked.slice(0, 2).map((d) => d.id) }));
