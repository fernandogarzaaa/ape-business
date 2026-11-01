# HUB-001: static signature scanning does not work for environment auditing

**Subject:** Prime Intellect Environments Hub, 20 public environments
**Result:** negative — about the method, not the hub
**Status:** complete. The tooling is throwaway; the finding is not.

Item 3 of `docs/research/05-COMPETITIVE-SCAN.md` §6: point the auditor at the
Environments Hub, on the reasoning that published defect rates of 28–68% mean
"a weekend produces a public report naming hundreds of broken environments."

That is not what happened, and the reason is worth more than the report would
have been.

---

## 1. What was actually done

Feasibility first, and it is good: the hub is fully accessible without an
account. `uv tool install prime` gives a CLI whose own help text tells AI
callers to use `--plain` and `--output json`. `prime env list` enumerates
public environments; `prime env pull` fetches a complete environment archive in
about six seconds. Environments are Python packages built on the `verifiers`
library, with the reward function in plain source.

A first attempt used `prime env inspect` per file — one network round trip
each, roughly 40 per environment. It was abandoned after seven environments in
ten minutes. Bulk `pull` is ~100× faster and is what a real survey should use.

The survey (`survey2.py`, reproduced in §6) pulled **20 environments**, walked
their Python source, and grepped for regex *signatures* of the defect classes
in Ray's taxonomy (arXiv 2606.01066) plus a few grader-robustness smells.

## 2. The headline numbers, and why they are not a finding

| Signature class | Environments matched | % of 20 |
|---|---|---|
| `substring_match_grading` | 18 | 90% |
| `loose_answer_extraction` | 10 | 50% |
| `loose_numeric_tolerance` | 6 | 30% |
| `missing_timeouts` | 3 | 15% |
| `stdout_trusted` | 3 | 15% |
| `llm_judge` | 2 | 10% |
| `last_token_wins` | 2 | 10% |

Read naively this says 90% of hub environments grade by substring matching and
half scrape answers with loose regexes — comfortably inside the 28–68% band the
competitive scan predicted, and exactly the report that section anticipated.

**It would have been wrong.** Every class checked by hand was dominated by
false positives.

## 3. What manual confirmation found

The survey was written with the rule that a signature is a hypothesis, never a
confirmed defect. Applying that rule dismantled the results.

### 3.1 `stdout_trusted` — 0 of 5 hits real

All five matched non-grading code:

```
supabase-evals   rollout_turn_metrics.py:609  help="Emit JSON summary to stdout instead of text"
sregym-env       cli.py:344                   sys.stdout.reconfigure(line_buffering=True)
omp-coding       _vendor/omp_rpc/client.py    self._stdout_thread: threading.Thread | None = None
```

A CLI flag's help string, terminal line-buffering, and a vendored RPC client's
thread handle. None is a grader trusting process output.

### 3.2 `missing_timeouts` — the one that mattered was backwards

`mayokun26/research-debugging` was flagged twice. Pulling and reading it:

```python
# research_debugging/taskset.py:64 — the actual grading path
result = subprocess.run(
    [sys.executable, str(HIDDEN_SRC / "verifier.py"), str(submission)],
    capture_output=True,
    text=True,
    timeout=900,          # <-- present, on a later line
    check=False,
)
```

The verifier invocation **has a timeout**. The regex flagged it because
`timeout=` sits on a line the pattern could not see. The other hit
(`check_env.py:21`) is a build helper that never runs during grading.

4 of 10 `missing_timeouts` hits end in an open paren — structurally invisible
to a line-oriented regex.

### 3.3 `llm_judge` — 0 of 2 real

`itsm-bench`'s hit is `user_sim.py`, a *simulated user* the agent converses
with, not a judge. `automationbench`'s hits are inside
`tools/zapier/chatgpt/completions.py` — a tool the agent is given, not a
grader. Both are LLM calls in the environment; neither is an LLM deciding
reward.

### 3.4 `substring_match_grading` — 477 hits, mostly `startswith`

477 raw hits across 20 environments. **288 of them are plain `startswith(` or
`endswith(`** — string handling that appears in every Python codebase. The
class is noise.

## 4. The actual finding

> **Static signature scanning over whole environment repositories does not
> distinguish the grading path from everything else, and therefore cannot
> measure environment defect rates.**

The failure is structural, not a matter of tuning regexes. An RL environment
package contains a task generator, a simulated user, agent-facing tools, a CLI,
a test suite, vendored dependencies, and a reward function. Only the last one
can have a *reward* defect. Every pattern in Ray's taxonomy —
`stdout_spoofing`, `missing_timeouts`, `loose_answer_extraction` — describes
something the **grader** does. The same code shape elsewhere in the package is
irrelevant, and grep cannot tell the difference.

This is the same lesson the assurance module already encodes as a hard rule,
arriving from the other direction. `src/assurance/probe.ts` refuses to run a
suite with no control probes, because *a detector that flags everything is as
useless as one that flags nothing.* This survey built a detector that flags
everything. It failed its own project's standard.

Two corollaries:

- **Any published "N% of environments are broken" figure derived this way
  should be distrusted**, including one this project could easily have
  published this week.
- The 28–68% rates cited in `05-COMPETITIVE-SCAN.md` come from work that did
  not do this (Ray fuzzes verifiers dynamically; the SWE-bench figures come
  from executing patches against test suites). That contrast is the point.

## 5. A verified counterexample: one environment that is genuinely sound

`halfounce/exact-determinant` matched three signature classes and is, on
inspection and testing, **well built** — the strongest single argument against
the naive reading of §2.

Its grader recomputes `det(A)` by fraction-free Bareiss elimination at verify
time and compares exactly. Claims in its README were tested directly rather
than believed (stdlib-only `core.py`, loaded in isolation to bypass the
`datasets` dependency):

```
cross-certification (300 random matrices) -> HOLDS
rejection floor |det| >= 10^(n-1) (40)    -> HOLDS
no |g| <= 9999 is ever correct (n>=5)     -> HOLDS
exact-only grader, never raises           -> HOLDS
```

It was flagged `last_token_wins` for this extractor:

```python
toks = re.findall(r"-?[0-9]{1,3}(?:,[0-9]{3})+|-?[0-9]+", text or "")
return toks[-1].replace(",", "")
```

Taking the last token *is* Ray's `missing_markers` shape. It is **not
exploitable here**, for three compounding reasons:

1. Last-token-wins gives exactly one attempt. Emitting many candidate answers
   does not help — only the final one is read. (Contrast an "any match wins"
   extractor, which enumeration defeats.)
2. Minting rejects `|det| < 10^(n-1)`, so at n≥5 no integer with `|g| ≤ 9999`
   is ever correct. Guessing is hopeless by construction.
3. The grader recomputes from the matrix; a stored label is never trusted.

Confirmed empirically — `verify_determinant` returns 1.0 only for the exact
value, 0.0 for `d±1`, floats, non-numerics, empty strings and 5000-digit
inputs, and never raises.

**A defect signature, correctly identified, in a grader where it cannot be
exploited.** This is what the false-positive discipline is for.

## 6. What a real hub audit would require

Dynamic, not static, and scoped to the grading path:

1. **Find the reward function structurally, not textually.** Parse the AST,
   locate the `Rubric` / reward callables an environment registers, and walk
   *their* call graph. Only code reachable from a reward function can hold a
   reward defect.
2. **Probe it, don't read it.** Load the environment, construct completions
   that satisfy a defect but not the task, and check whether reward is granted
   — exactly what `src/assurance/` does for RLVR verifiers and now for EVE's
   behavioral oracle. Signatures pick targets; probes produce findings.
3. **Budget honestly.** Meaningful dynamic probing of agentic environments
   needs model inference, and multi-turn environments need rollouts. That is a
   real cost this reconnaissance did not incur and did not estimate.

Step 1 is the blocker, and it is a genuine piece of work rather than a
refinement of what is here.

## 7. Reproduction

```bash
uv tool install prime
python3 survey2.py 20      # ~15 min, no account required
```

`survey2.py` is preserved at `docs/assurance/findings/hub-survey/survey2.py`
with its raw output. It is kept as the artifact of a negative result, **not as
a tool to build on** — §4 is the argument for why building on it would be a
mistake.

## 8. What this does and does not establish

**Establishes:** the hub is openly accessible and cheaply enumerable; bulk pull
is the right access pattern; and static signature scanning over whole packages
cannot measure grading defects, with false positives verified by hand in every
class examined.

**Does not establish:** anything about the actual defect rate of hub
environments. That number remains unmeasured by this project. The published
28–68% figures come from dynamic methods and are not contradicted here — they
are simply not reproduced, because the method used could not reproduce them.

**One environment was examined closely enough to judge**
(`halfounce/exact-determinant`), and it was sound. Nineteen were not. No
conclusion about the population follows from either fact.
