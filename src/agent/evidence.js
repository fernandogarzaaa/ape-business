// Evidence correlation — combine verification outputs across engines into one
// grounding judgment, instead of treating each tool's result in isolation.
// A Genesis SOUND plus an EVE 40/100 must not both quietly "pass"; the gate
// needs agree / conflict / insufficient, with reasons.
//
// Normalized verdicts per source:
//   positive — supports the claim (genesis SOUND, EVE score >= threshold, eval ok)
//   negative — refutes it (genesis EXPLOITABLE, EVE score < threshold, eval failed)
//   neutral  — inconclusive (UNTESTED, compare deltas, missing fields)
// Correlation:
//   agree        — >=1 positive, zero negatives
//   conflict     — >=1 positive AND >=1 negative, or a lone negative
//   insufficient — zero sources, or neutrals only
import { sha256hex } from "./outcomes.js";

// Full verifier results are capped for memory (matches the tool-message cap).
export const EVIDENCE_FULL_CAP = 8000;

// Evidence artifact: the gate consumes the FULL verifier result, never the
// 300-char ledger summary. A verdict past the truncation point must not
// silently degrade to "neutral". The digest pins the exact bytes judged.
export function buildEvidence({ tool, fullText, step, eveThreshold = 50 }) {
  const full = String(fullText ?? "").slice(0, EVIDENCE_FULL_CAP);
  const v = extractVerdict(tool, full);
  let verdict = v.verdict;
  if (verdict === "__SCORE__") verdict = (v.score ?? 0) >= eveThreshold ? "positive" : "negative";
  return {
    evidence_id: "ev-" + sha256hex(tool + "\n" + full).slice(0, 16),
    tool,
    step,
    verdict,
    detail: v.detail,
    score: v.score ?? null,
    digest: "sha256:" + sha256hex(full),
    excerpt: full.slice(0, 300),
  };
}
export function extractVerdict(tool, resultSummary) {
  const text = String(resultSummary ?? "");
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* truncated or plain text; fall through to regex */ }
  const hay = text;

  if (tool === "genesis.audit_claim") {
    const v = parsed?.verdict ?? (/VERDICT:\s*(SOUND|EXPLOITABLE|UNTESTED|UNRELIABLE)/.exec(hay)?.[1] ?? null);
    if (v === "SOUND") return { verdict: "positive", detail: "genesis SOUND" };
    if (v === "EXPLOITABLE") return { verdict: "negative", detail: "genesis EXPLOITABLE" };
    return { verdict: "neutral", detail: `genesis ${v ?? "inconclusive"}` };
  }
  if (tool === "eve.validate_experience") {
    const m = /Overall experience score\s*:\s*(\d+)/.exec(hay);
    const score = m ? Number(m[1]) : (typeof parsed?.score === "number" ? parsed.score : null);
    if (score === null) {
      if (parsed && !parsed.error) return { verdict: "neutral", detail: "eve ran, no score parsed" };
      return { verdict: "neutral", detail: "eve inconclusive" };
    }
    return { verdict: "__SCORE__", score, detail: `eve score ${score}/100` };
  }
  if (tool === "eve.mcp_eval") {
    if (parsed && parsed.ok === true) return { verdict: "positive", detail: "mcp-eval ok" };
    if (parsed && parsed.ok === false) return { verdict: "negative", detail: "mcp-eval failed" };
    return { verdict: "neutral", detail: "mcp-eval inconclusive" };
  }
  if (tool === "genesis.compare") {
    if (parsed && !parsed.error) return { verdict: "neutral", detail: "compare delta (informational)" };
    return { verdict: "neutral", detail: "compare inconclusive" };
  }
  return { verdict: "neutral", detail: `${tool} (not a verification source)` };
}

export function correlateEvidence(steps, { verifyTools = [], eveThreshold = 50 } = {}) {
  const sources = [];
  for (const s of steps ?? []) {
    if (s.kind !== "tool" || !verifyTools.includes(s.tool)) continue;
    // Prefer the full verifier result carried in-memory; fall back to the
    // truncated ledger summary (e.g. post-resume steps that predate artifacts).
    const text = s.fullResult ?? s.resultSummary;
    // Skip failed calls — an error is not evidence for or against the claim.
    if (String(text ?? "").includes('"error"')) continue;
    const v = extractVerdict(s.tool, text);
    let verdict = v.verdict;
    if (verdict === "__SCORE__") verdict = (v.score ?? 0) >= eveThreshold ? "positive" : "negative";
    sources.push({ tool: s.tool, verdict, detail: v.detail, score: v.score ?? null });
  }
  if (!sources.length) return { status: "insufficient", sources, reasons: ["no successful verification steps"] };
  const positives = sources.filter((s) => s.verdict === "positive");
  const negatives = sources.filter((s) => s.verdict === "negative");
  if (positives.length && !negatives.length) {
    return {
      status: "agree",
      sources,
      reasons: positives.map((s) => s.detail),
      singleSource: sources.length === 1,
    };
  }
  return {
    status: "conflict",
    sources,
    reasons: [
      ...positives.map((s) => "supports: " + s.detail),
      ...negatives.map((s) => "refutes: " + s.detail),
    ],
  };
}