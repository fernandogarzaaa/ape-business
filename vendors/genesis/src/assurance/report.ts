/**
 * Audit report rendering.
 *
 * Structured findings, each citing the probe that produced it and the digest of
 * the stored transcript — the schema ABA (arXiv 2605.26079) uses for benchmark
 * auditing, applied to verifiers. A finding you cannot trace back to a specific
 * input and a specific response is an opinion.
 */

import { formatInterval } from "../backtest/metrics.js";
import type { AuditRecord } from "./audit.js";
import type { Finding, ProbeResult } from "./findings.js";

const MARK: Record<ProbeResult["outcome"], string> = {
  correct: "✓",
  false_accept: "✗",
  false_reject: "✗",
  unresponsive: "⧗",
  error: "!",
};

export function renderAudit(record: AuditRecord, options: { verbose?: boolean } = {}): string {
  const { conclusion, results } = record;
  const { metrics } = conclusion;
  const lines: string[] = [];

  lines.push("");
  lines.push(`VERDICT: ${conclusion.verdict.replace("_", " ")}`);
  lines.push(`Verifier "${record.verifier}" against suite ${record.suite}@${record.suite_version}`);
  lines.push(`Suite digest ${record.suite_digest.slice(0, 12)} · ${metrics.probes_run} probes ` +
    `(${metrics.exploit_probes} exploit, ${metrics.control_probes} control)`);
  lines.push("");

  lines.push("RATES");
  lines.push(`  False-accept   ${formatInterval(metrics.false_accept_rate)}`);
  lines.push("    accepted a completion that satisfies a defect but not the task");
  lines.push(`  False-reject   ${formatInterval(metrics.false_reject_rate)}`);
  lines.push("    rejected a genuinely correct completion");
  if (metrics.error_rate.point > 0) {
    lines.push(`  Unreadable     ${formatInterval(metrics.error_rate)}`);
  }
  lines.push("");

  if (conclusion.findings.length > 0) {
    lines.push(`FINDINGS (${conclusion.findings.length})`);
    lines.push("");
    for (const finding of conclusion.findings) {
      renderFinding(lines, finding);
    }
  }

  const clean = metrics.by_class.filter(
    (c) => c.false_accepts === 0 && c.unresponsive === 0 && c.errors === 0,
  );
  if (clean.length > 0) {
    lines.push(`RESISTED (${clean.length})`);
    lines.push(`  ${clean.map((c) => `${c.defect_class} (${c.exploit_probes})`).join(", ")}`);
    lines.push("");
  }

  if (options.verbose) {
    lines.push("PROBES");
    for (const result of results) {
      lines.push(
        `  ${MARK[result.outcome]} ${result.probe_id.padEnd(28)} ` +
          `expect ${result.expected.padEnd(6)} observed ${result.observed.padEnd(12)} ` +
          `${result.duration_ms}ms`,
      );
      if (result.note) lines.push(`      ${result.note}`);
    }
    lines.push("");
  }

  lines.push("WHY");
  for (const reason of conclusion.rationale) lines.push(`  ${wrap(reason, 76, "  ")}`);
  lines.push("");

  lines.push(
    "SCOPE: this audit bounds only the defect classes the suite probes. A SOUND verdict " +
      "is not a claim of general correctness.",
  );

  if (record.ledger_entry) {
    lines.push(`Ledger: entry ${record.ledger_entry.slice(0, 12)}`);
  }
  lines.push("");

  return lines.join("\n");
}

function renderFinding(lines: string[], finding: Finding): void {
  lines.push(`  [${finding.severity}] ${finding.defect_class} — ${finding.title}`);
  lines.push(`      ${wrap(finding.summary, 72, "      ")}`);
  if (finding.severity === "exploitable") {
    lines.push(`      exploit: ${wrap(finding.exploit, 72, "               ")}`);
  }
  for (const evidence of finding.evidence) {
    lines.push(`      ${MARK[evidence.outcome]} ${evidence.probe_id}`);
    lines.push(`          ${wrap(evidence.rationale, 68, "          ")}`);
    if (evidence.artifact_digest) {
      lines.push(`          artifact ${evidence.artifact_digest.slice(0, 16)}`);
    }
  }
  lines.push("");
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let current = "";

  for (const word of words) {
    if (current === "") current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current !== "") out.push(current);

  return out.join(`\n${indent}`);
}
