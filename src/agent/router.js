// Task-based model routing — pick the cheapest sufficient provider for the objective,
// instead of always using the active/default model. Rule-based and explicit (no hidden
// model call): keyword scoring per category, ties and no-signal fall through to
// "general" (no routing; use normal resolution). The decision + confidence are
// recorded in the receipt so routing quality can be judged from the ledger later.
const KEYWORDS = {
  trivial: ["parse", "extract", "format", "list", "summar", "translat", "convert", "count", "classif", "label", "dedupe", "dedup", "sort", "filter", "validat", "check", "transform", "shorten", "rewrite"],
  coding: ["code", "bug", "fix", "implement", "refactor", "test", "repo", "file", "function", "api", "endpoint", "commit", "pull request", "build", "error", "stack", "debug", "program", "script", "deplo"],
  reasoning: ["architect", "design", "decid", "decis", "compar", "tradeoff", "trade-off", "strateg", "plan", "evaluat", "choos", "recommend", "analy", "why ", "should", "proposal", "review"],
};

export function classifyObjective(objective) {
  const text = String(objective ?? "").toLowerCase();
  const scores = { trivial: 0, coding: 0, reasoning: 0 };
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    for (const w of words) {
      if (text.includes(w)) scores[cat]++;
    }
  }
  const total = scores.trivial + scores.coding + scores.reasoning;
  if (!total) return { category: "general", confidence: 0, reasons: ["no category keywords"] };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, topScore] = ranked[0];
  const [, secondScore] = ranked[1];
  if (topScore === secondScore) {
    return { category: "general", confidence: 0, reasons: [`tie between ${ranked[0][0]} and ${ranked[1][0]}`] };
  }
  return {
    category: top,
    confidence: Number((topScore / total).toFixed(2)),
    reasons: [`${topScore}/${total} keyword hits for ${top}`],
  };
}

// Select a provider+model for the category from what's actually detected.
// Trivial tasks go local (free) when a local model exists; otherwise everything
// uses the normal resolution. Never invents credentials — returns null when the
// preferred target isn't available.
export async function selectRoutedModel(category, { detected = [], resolveProvider }) {
  if (category === "trivial" && detected.includes("local") && resolveProvider) {
    const local = await resolveProvider("local");
    if (local && !local.error) return { ...local, routed: true, routeReason: "trivial task -> local (free)" };
  }
  return null;
}
