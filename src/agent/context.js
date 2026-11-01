// Context management — bounded history with recoverable digests.
// When estimated history tokens exceed the profile cap, older tool-result turns are
// replaced by one-line digests (tool + args hash + summary). The full data remains in
// runs.db steps, so nothing is lost — the model sees less, the ledger keeps everything.
export function estimateTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

// --- Tool-result truncation with previews (context hygiene) ---
//
// Bulky tool outputs are the dominant context consumer in agent loops. Instead of
// silently slicing them, truncate to a token budget with an explicit marker: the
// model sees a head/tail preview plus a stash ref it can page through on demand
// via the context.retrieve tool. The full result is never lost — it lives in the
// durable stash (runs.db), keyed per run.

export const CONTEXT_DEFAULTS = {
  max_result_tokens: 1500,
  preview_tokens: 750,
  mode: "head-tail",
  retrieve: true,
  max_stash_chars: 100000,
  per_tool: {},
};

function clampInt(v, fallback, min) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

function validatedMode(v) {
  return v === "head" || v === "tail" || v === "head-tail" ? v : CONTEXT_DEFAULTS.mode;
}

// Validates one context-hygiene config layer. Every field is optional; absent
// fields fall through to the next layer (see resolveHygiene). Exported so
// profiles.js can normalize policy.context at load time.
export function validateContextLayer(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  if (raw.max_result_tokens !== undefined) out.max_result_tokens = clampInt(raw.max_result_tokens, CONTEXT_DEFAULTS.max_result_tokens, 100);
  if (raw.preview_tokens !== undefined) out.preview_tokens = clampInt(raw.preview_tokens, CONTEXT_DEFAULTS.preview_tokens, 100);
  if (raw.mode !== undefined) out.mode = validatedMode(raw.mode);
  if (raw.retrieve !== undefined) out.retrieve = raw.retrieve !== false;
  if (raw.max_stash_chars !== undefined) out.max_stash_chars = clampInt(raw.max_stash_chars, CONTEXT_DEFAULTS.max_stash_chars, 1000);
  if (raw.per_tool !== undefined) {
    const pt = {};
    if (raw.per_tool && typeof raw.per_tool === "object" && !Array.isArray(raw.per_tool)) {
      for (const [k, v] of Object.entries(raw.per_tool)) {
        const layer = validateContextLayer(v);
        delete layer.per_tool;
        delete layer.retrieve;
        if (Object.keys(layer).length) pt[String(k)] = layer;
      }
    }
    out.per_tool = pt;
  }
  return out;
}

// Merges config layers, weakest first: hardcoded defaults < global (ape.config)
// < profile policy.context < per-tool overrides (profile beats global).
export function resolveHygiene({ global = {}, profile = {}, toolName = "" } = {}) {
  const g = validateContextLayer(global);
  const p = validateContextLayer(profile);
  const gt = validateContextLayer(g.per_tool?.[toolName]);
  const pt = validateContextLayer(p.per_tool?.[toolName]);
  const pick = (k) => pt[k] ?? p[k] ?? gt[k] ?? g[k] ?? CONTEXT_DEFAULTS[k];
  const maxTokens = pick("max_result_tokens");
  return {
    maxTokens,
    previewTokens: Math.min(pick("preview_tokens"), maxTokens),
    mode: pick("mode"),
    retrieve: p.retrieve ?? g.retrieve ?? CONTEXT_DEFAULTS.retrieve,
    maxStashChars: p.max_stash_chars ?? g.max_stash_chars ?? CONTEXT_DEFAULTS.max_stash_chars,
  };
}

// Truncate a tool result to a token budget. Under budget the text passes through
// untouched; over budget the model gets a preview plus an explicit marker naming
// the stash ref for on-demand paged retrieval. Token math reuses the estimator
// above (chars/4), consistent with compressHistory.
export function truncateToolOutput(text, { maxTokens = 1500, previewTokens = 750, mode = "head-tail", ref = null, toolName = "" } = {}) {
  const str = String(text ?? "");
  const totalTokens = Math.ceil(str.length / 4);
  if (totalTokens <= maxTokens) return { text: str, truncated: false, omittedTokens: 0, ref: null };
  const budget = Math.max(100, Math.min(previewTokens, maxTokens));
  const budgetChars = budget * 4;
  const omitted = Math.max(0, totalTokens - budget);
  const name = toolName ? `"${toolName}" ` : "";
  const marker =
    `[truncated ~${omitted} tokens of ${name}output omitted` +
    (ref ? `; full result stashed as ref "${ref}" - call context.retrieve with {"ref":"${ref}"} to page through it` : "") +
    `]`;
  const m = validatedMode(mode);
  let preview;
  if (m === "head") {
    preview = str.slice(0, budgetChars) + "\n" + marker;
  } else if (m === "tail") {
    preview = marker + "\n" + str.slice(-budgetChars);
  } else {
    const half = Math.floor(budgetChars / 2);
    preview = str.slice(0, half) + "\n" + marker + "\n" + str.slice(-half);
  }
  return { text: preview, truncated: true, omittedTokens: omitted, ref };
}

export function compressHistory(messages, { maxHistoryTokens = 60000, keepRecentTurns = 4 } = {}) {
  const before = estimateTokens(messages);
  if (before <= maxHistoryTokens) return { messages, compressed: 0, savedTokens: 0 };
  // Never compress the system/objective head (first message) — only middle turns.
  // A "turn" is an assistant message + its tool results; keep the tail intact.
  const head = messages.slice(0, 1);
  const tail = messages.slice(-keepRecentTurns * 2);
  const middle = messages.slice(1, Math.max(1, messages.length - keepRecentTurns * 2));
  let compressed = 0;
  const digested = middle.map((m) => {
    if (m.role === "tool") {
      compressed++;
      return { ...m, content: `[digested tool result ${m.toolCallId ?? ""}: ${(m.content ?? "").slice(0, 160)}…]` };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return { role: "assistant", content: (m.content ?? "").slice(0, 200), toolCalls: m.toolCalls.map((tc) => ({ ...tc, args: {} })) };
    }
    return { role: m.role, content: String(m.content ?? "").slice(0, 300) };
  });
  return { messages: [...head, ...digested, ...tail], compressed, savedTokens: Math.max(0, before - estimateTokens([...head, ...digested, ...tail])) };
}
//
// Proactive compression (compressHistory above) keeps history under the
// profile cap, but the provider's real context window can still reject a
// call: different models, different windows, and the char/4 estimator is
// approximate. When the provider says the context is too long, the loop
// should shrink and retry instead of halting — that is the third Strands
// context-hygiene behavior (truncate outputs, compact the window, recover
// from overflow inside the loop).

const OVERFLOW_PATTERNS = [
  /context_length_exceeded/i,
  /maximum context( length)?/i,
  /context window/i,
  /too many tokens/i,
  /input.*too (long|large)/i,
  /prompt.*too long/i,
  /reduce the length of/i,
  /context.{0,20}limit/i,
];

// True when err looks like a provider context-length rejection rather than
// any other model failure. Conservative on purpose: unknown errors keep the
// old halt behavior instead of triggering a shrink-and-retry loop.
export function isContextOverflowError(err) {
  if (!err) return false;
  const status = err.status ?? err.statusCode ?? err.code;
  const msg = String(err.message ?? err ?? "");
  if ((status === 400 || status === 413) && OVERFLOW_PATTERNS.some((p) => p.test(msg))) return true;
  if (typeof status === "string" && /context_length_exceeded/i.test(status)) return true;
  return OVERFLOW_PATTERNS.some((p) => p.test(msg));
}

export const MAX_OVERFLOW_RECOVERIES = 2;

// Aggressively shrink messages after an overflow rejection: halve the
// estimated token budget and keep only the 2 most recent turns intact.
// Returns null when nothing more can be digested (already at the floor),
// signalling the caller to halt honestly instead of retrying forever.
export function recoverFromOverflow(messages) {
  const before = estimateTokens(messages);
  const c = compressHistory(messages, {
    maxHistoryTokens: Math.max(1000, Math.floor(before / 2)),
    keepRecentTurns: 2,
  });
  if (c.compressed === 0) return null;
  return { messages: c.messages, compressed: c.compressed, savedTokens: c.savedTokens ?? 0, before, after: estimateTokens(c.messages) };

}
