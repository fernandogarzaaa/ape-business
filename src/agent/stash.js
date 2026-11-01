// Durable L1 stash for truncated tool results (context hygiene).
//
// When a tool result exceeds the truncation budget, the loop stores the full
// text here (keyed by run key + short ref) and the model sees only a preview
// with the ref. The agent recovers the original on demand through the
// context.retrieve tool, which returns bounded pages — a page can never
// re-create the overflow that truncation was meant to prevent.
import { randomBytes } from "node:crypto";
import { open } from "../runs.js";

const MAX_PAGE_CHARS = 8000;
const STASH_TTL_DAYS = 7;

export function stashResult({ runKey, tool = "", fullText = "", maxChars = 100000 } = {}) {
  if (!runKey) return { ref: null, stashed: false, reason: "no_run_key" };
  const text = String(fullText ?? "");
  if (!text) return { ref: null, stashed: false, reason: "empty" };
  const ref = "tr-" + randomBytes(4).toString("hex");
  const capped = text.length > maxChars;
  const stored = capped ? text.slice(0, maxChars) : text;
  try {
    const db = open();
    db.prepare(
      "INSERT OR REPLACE INTO tool_result_stash (run_key, ref, tool, full_text, capped, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(runKey, ref, String(tool ?? ""), stored, capped ? 1 : 0, new Date().toISOString());
    // Opportunistic hygiene: drop rows older than the TTL so the stash cannot
    // grow without bound across runs.
    try {
      db.prepare("DELETE FROM tool_result_stash WHERE created_at < ?").run(
        new Date(Date.now() - STASH_TTL_DAYS * 86400000).toISOString()
      );
    } catch { /* prune is best-effort */ }
    return { ref, stashed: true, capped };
  } catch (e) {
    return { ref: null, stashed: false, reason: String(e?.message ?? e).slice(0, 120) };
  }
}

export function retrieveResult({ runKey, ref, offsetChars = 0, limitChars = 4000 } = {}) {
  if (!runKey || !ref) return { error: "missing_ref", hint: "pass the ref from a [truncated ...] marker" };
  const offset = Math.max(0, Math.floor(Number(offsetChars) || 0));
  const limit = Math.min(MAX_PAGE_CHARS, Math.max(1, Math.floor(Number(limitChars) || 4000)));
  let row;
  try {
    row = open().prepare("SELECT tool, full_text, capped FROM tool_result_stash WHERE run_key = ? AND ref = ?").get(runKey, String(ref));
  } catch (e) {
    return { error: "stash_unavailable", message: String(e?.message ?? e).slice(0, 120) };
  }
  if (!row) return { error: "unknown_ref", ref: String(ref), hint: "ref not found for this run; it may have expired" };
  const total = row.full_text.length;
  const text = row.full_text.slice(offset, offset + limit);
  return {
    ref: String(ref),
    tool: row.tool ?? "",
    totalChars: total,
    offsetChars: offset,
    returnedChars: text.length,
    hasMore: offset + limit < total,
    capped: row.capped === 1,
    text,
  };
}
