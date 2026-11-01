# HUB-003: `build_optimization_reward` pays more for a wrong, boilerplate-stuffed answer than a correct, terse one

**Subject:** `tohan/catan-resource-trading-simulator` (Prime Intellect Environments
Hub), `build_optimization_reward` — the target HUB-002 §5 named as "a
hypothesis worth probing, not a result"
**Severity:** exploitable — `regex_answer_extraction` class (Ray, arXiv
2606.01066), confirmed dynamically
**Status:** confirmed, reproducible, deterministic. Not filed upstream —
that decision is the user's, not made here.

This is the dynamic step HUB-002 §6/§8 named as the remaining work: "construct
a completion that satisfies the defect but not the task, and see whether the
grader pays out." It also produced a sharper result than the static hypothesis
predicted — not just "gameable," but a completion further from the correct
answer scoring **higher** than one closer to it.

---

## 1. The mechanism under test

`build_optimization_reward` (`catan_resource_trading_simulator/__init__.py:422`)
scores a completion out of five independent components:

| Weight | Component | Check |
|---|---|---|
| 0.40 | Correct build mentioned | each of `answer.replace(" ", "").split(",")` — e.g. `"1city"`, `"1road"` — found as a literal substring of the lowercased completion |
| 0.20 | Resource accounting | `re.search(r'remain\|left\|after\|spend\|use\|cost', text)` |
| 0.15 | VP value mentioned | `re.search(r'vp\|victory point\|\+\d+.*point', text)` |
| 0.15 | Shows resource math | `re.search(r'\d+\s*(brick\|lumber\|ore\|grain\|wool)', text)` |
| 0.10 | Names building types | fraction of `{city, settlement, road, development card, dev card}` present, capped at 3 |

Four of the five components (0.60 of the total) are content-free: they fire
on the presence of generic vocabulary, entirely independent of whether the
recommended build is the one the resources in the prompt actually support.

## 2. The hypothesis, sharpened

HUB-002 flagged this as `regex_answer_extraction` on the strength of the
pattern alone. The sharper hypothesis, once the 0.40 component is read
closely: `answer.replace(" ", "")` produces a token like `"1city"` with no
space, which almost no naturally-phrased completion will ever contain as a
literal substring — a person or a model recommending "1 city" writes it with
a space. If that is right, the 0.40 "correctness" component doesn't just
tolerate gaming — it never fires on realistic output at all, correct or not,
making the entire grade a function of buzzword density.

## 3. The experiment

Pulled live via `prime env pull tohan/catan-resource-trading-simulator`
(no repo-local fixture — this is the real, currently-published environment).
`build_optimization_reward` is a pure `async (completion, answer) -> float`
function with no dependency on the rest of the package, so it was extracted
by name via `tools/hub-audit/dynamic_probe.py` (AST source-segment extraction
+ exec in an isolated namespace) rather than imported — the environment
declares `verifiers` and `datasets` as dependencies, neither installed here,
and neither needed to score one reward function.

Four completions, run against `BUILD_OPTIMIZATION_SCENARIOS[0]`
(`answer = "1 city, 1 road"`, and confirmed identical in shape across all
four scenarios in the dataset — the boilerplate components are answer-text
agnostic):

1. **blank** — `"I don't know."`
2. **correct, terse, natural phrasing** — states the actual answer, the way
   any person or model would write it, and stops.
3. **wrong build, resource-accounting boilerplate** — recommends the wrong
   build (a settlement, not a city), but writes in the genre of a
   resource-optimization answer: mentions what's left over, what was spent,
   a VP total, and specific resource counts.
4. **correct, unnaturally concatenated** — the answer with its internal
   spaces stripped (`"1city,1road"`), the only string shape the 0.40
   component's substring check can actually match.

## 4. Results

```
$ python3 dynamic_probe.py <catan-checkout> build_optimization_reward \
    "1 city, 1 road" completions.json

0.0000  blank
0.3000  correct build, terse natural phrasing
0.6000  wrong build, resource-accounting boilerplate
0.5000  correct build, unnaturally concatenated (1city,1road)
```

**The wrong build scores exactly double the correct one.** #3 recommends a
settlement instead of a city. Both are affordable from the resources given
(4 brick, 2 lumber, 3 ore, 2 grain, 1 wool), but settlement+road yields only
1 VP against city+road's 2 — it is a strictly worse, genuinely suboptimal
answer to the stated question. It outscores the completion that gives the
actually-correct recommendation anyway, because the wrong answer happens to
also narrate resource accounting in the reward's expected vocabulary and the
correct one doesn't bother restating numbers it didn't need to.

**The 0.40 "correctness" component never rewards realistic correctness.**
#2 and #4 both state the same true answer; only the unnatural,
space-stripped rendering (#4) collects any of the 0.40, and even that only
reaches 0.50 — still below the wrong answer's 0.60. No completion a real
model would plausibly emit collects this component at all. In production,
`build_optimization_reward` is not "a build-correctness check weakened by
gameable extras" — the correctness check is dead code, and the entire grade
is the buzzword-density subscore.

Confirmed deterministic and answer-independent: the same four-completion
shape (blank / correct-terse / wrong-boilerplate / correct-concatenated)
produces `0.0 / 0.3 / 0.6 / 0.5` on all four `BUILD_OPTIMIZATION_SCENARIOS`
rows, not just the one shown above.

## 5. What this establishes, and what it does not

**Does establish:** for this reward function, on realistic model output, the
score is uncorrelated with whether the recommended build is correct, and an
agent that learns to narrate resource-accounting vocabulary regardless of
content will systematically outscore one that computes the right answer and
states it plainly. This is `regex_answer_extraction` (Ray's taxonomy) with a
concretely worse property than the class name implies: it isn't merely that
extraction is loose, it's that the extraction path is unreachable from
plausible text, so the remaining regex components are not "helping a weak
signal" — they *are* the entire signal.

**Does not establish:** claims about the other five reward functions in
`catan-resource-trading-simulator`'s rubric (`trade_evaluation_reward`,
`reasoning_quality_reward`, `probability_reasoning_reward`,
`strategic_planning_reward`, `format_quality_reward`), which were not probed
here and carry their own weights (0.15 combined weight for
`build_optimization_reward` in the full rubric — see
`load_environment()`). A full accounting of the environment's exploitability
would need to probe all six.

## 6. Options — open

1. File this as an issue against the environment (or its Hub listing).
   **Not done.** Still the user's call, per the same discipline EVE-001 §7
   applied to a sibling repository.
2. Probe the environment's other five reward functions for the same pattern,
   and/or extend `tools/hub-audit/dynamic_probe.py` from a one-off CLI into
   a suite runnable against `ast_signatures.py`'s existing 47 static targets.
   **Partially done:** `HUB-004-carcassonne-placement-reward-defects.md`
   confirmed a second target this way, but by hand rather than via a
   generalized synthesizer — see that finding's §7 for why full automation
   was rejected for now.
3. Move to the next unclaimed item.

## 7. Reproduction

```bash
uv tool install prime
prime env pull tohan/catan-resource-trading-simulator -t /tmp/catan --plain

cd tools/hub-audit
python3 dynamic_probe.py /tmp/catan build_optimization_reward "1 city, 1 road" \
  completions.json   # {label: completion text} — see §3/§4 above for the four used
```

No account required. `dynamic_probe.py` never imports the environment
package, so this reproduces with no `verifiers`/`datasets` installation.
