// Budget governor — the only thing between a misconfigured loop and an unbounded bill.
// Not optional polish: max_usd / max_steps / max_tokens / max_wall_seconds all halt
// the loop independently, and the loop checks after EVERY model call and tool call.
export function makeBudget(limits, startTime = Date.now()) {
  return {
    limits,
    steps: 0,
    tokens: 0,
    usd: 0,
    started: startTime,
    lastReason: null,
    spend({ tokens = 0, cost = 0 } = {}) {
      this.tokens += tokens;
      this.usd += cost;
    },
    check() {
      if (this.limits.max_steps != null && this.steps >= this.limits.max_steps) return this.halt("max_steps");
      if (this.limits.max_tokens != null && this.tokens >= this.limits.max_tokens) return this.halt("max_tokens");
      if (this.limits.max_usd != null && this.usd >= this.limits.max_usd) return this.halt("max_usd");
      if (this.limits.max_wall_seconds != null && Date.now() - this.started >= this.limits.max_wall_seconds * 1000) return this.halt("max_wall_seconds");
      return { exhausted: false };
    },
    halt(reason) {
      this.lastReason = reason;
      return { exhausted: true, reason };
    },
  };
}