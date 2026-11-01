// Trajectory health — drift beyond exact repeats. The loop already halts identical
// (tool, args) repeats; drift watches the softer degradations: semantic looping
// (same tool, ever-different args — wandering, not progressing), error spirals
// (consecutive failures burning budget), and stalls (no new tool variety).
// observe() folds each recorded tool step into rolling state; evaluate() turns
// state + profile config into warn (advisory message, run continues) or halt.
// Pure; the loop owns when to call it.
export function initDrift() {
  return {
    prevTool: null,
    sameTool: 0,
    maxSameTool: 0,
    consecErrors: 0,
    maxConsecErrors: 0,
    distinct: [],
    advisoryFor: null,
    warnings: 0,
  };
}

export function driftConfig(profile) {
  const d = profile?.policy?.drift;
  if (d === false) return null; // opted out
  return {
    warnStreak: Number(d?.warn_streak ?? 6),
    maxErrors: Number(d?.max_errors ?? 4),
  };
}

function isErrorSummary(summary) {
  const s = String(summary ?? "");
  return s === "unknown_tool" || s.includes("handler_failed") || s.includes('"error"');
}

export function observeDrift(state, { tool, summary }) {
  if (!tool) return state;
  if (tool === state.prevTool) state.sameTool++;
  else { state.prevTool = tool; state.sameTool = 1; state.advisoryFor = null; }
  if (state.sameTool > state.maxSameTool) state.maxSameTool = state.sameTool;
  if (isErrorSummary(summary)) {
    state.consecErrors++;
    if (state.consecErrors > state.maxConsecErrors) state.maxConsecErrors = state.consecErrors;
  } else {
    state.consecErrors = 0;
  }
  if (!state.distinct.includes(tool)) state.distinct.push(tool);
  return state;
}

// Returns { advisory } and/or { halt, stopReason, outcome }. Advisory fires once
// per streak (deduped via state.advisoryFor); halt fires on error spirals.
export function evaluateDrift(profile, state) {
  const cfg = driftConfig(profile);
  if (!cfg) return {};
  const out = {};
  if (state.consecErrors >= cfg.maxErrors) {
    out.halt = true;
    out.stopReason = "error_spiral";
    out.outcome = `halted: ${state.consecErrors} consecutive tool errors (${state.prevTool} latest) —retrying the same failing pattern burns budget`;
  } else if (state.sameTool >= cfg.warnStreak && state.advisoryFor !== state.prevTool) {
    state.advisoryFor = state.prevTool;
    state.warnings++;
    out.advisory = `Drift advisory: "${state.prevTool}" has been called ${state.sameTool} times in a row with different arguments and no finish. If this is wandering rather than converging, change strategy or finish with findings so far instead of continuing the same pattern.`;
  }
  return out;
}

export function driftReceipt(state) {
  return {
    max_same_tool_streak: state.maxSameTool,
    max_consecutive_errors: state.maxConsecErrors,
    distinct_tools: state.distinct.length,
    warnings: state.warnings,
  };
}
