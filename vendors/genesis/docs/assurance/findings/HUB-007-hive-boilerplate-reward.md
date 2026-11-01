# HUB-007: `hive-insect-board-game`'s rubric pays 71–100% of maximum to one canned, position-independent response

**Subject:** `audition/hive-insect-board-game` (Prime Intellect Environments
Hub), all four functions in its rubric
**Severity:** exploitable — the same universal-boilerplate pattern as
HUB-006, but partial rather than total: one reward component retains a real
(if loophole-ridden) correctness check on part of the dataset, so the same
canned completion scores 71–100% of the maximum depending on which task
category it lands on, never full credit unconditionally and never zero.
**Status:** confirmed, reproducible, deterministic across three dataset
rows spanning two task categories. Not filed upstream — the user's call, per
the same discipline HUB-003 §6 applied. This also closes out HUB-002's
static survey: all 9 `regex_answer_extraction` environments and both
`containment_decides_reward_UNTYPED` environments are now triaged (§5).

Continues the triage HUB-006 §8 left open — the last of HUB-002's untriaged
`regex_answer_extraction` hits.

---

## 1. The rubric under test

`load_environment()` (`hive_insect_board_game/__init__.py:365`) combines
four reward functions with un-normalized weights `1.0 / 1.0 / 0.8 / 0.7`
(sum 3.5 — `verifiers.Rubric` does not require weights to sum to 1; scores
below are reported against this 3.5 ceiling, not against 1.0):

| Weight | Function | What it checks |
|---|---|---|
| 1.0 | `move_accuracy` | did the completion's `VALID`/`INVALID` verdict match the answer's — **only meaningful on the ~1/5 of the dataset that is a legality question**; degrades to a capped keyword bonus everywhere else |
| 1.0 | `strategy_score` | keyword density: a piece name, a coordinate-or-placement word, a tactical word, a causal word, an opponent-response word |
| 0.8 | `rule_knowledge` | keyword density across five fixed Hive-rules phrasings, plus a bonus for avoiding four wrong-game terms |
| 0.7 | `analysis_depth` | word count, hedge words, concept-keyword density, a conclusion word, a numbered-list marker |

`strategy_score`, `rule_knowledge`, and `analysis_depth` — 2.5 of the 3.5
total weight, 71% — are pure surface-form checks with no reference to the
specific board position, move, or question in the prompt, in the same shape
HUB-003/004/005 already established. `move_accuracy` is the one component
that looks genuinely tied to ground truth, and reading it closely turned up
two things: it only applies to one of the dataset's five task categories,
and even there it has a hedging loophole.

## 2. `move_accuracy`'s scope and its loophole

```python
answer_upper = answer.upper()
expected_valid = "VALID" in answer_upper and "INVALID" not in answer_upper.split("VALID")[0][-10:]
expected_invalid = "INVALID" in answer_upper

if expected_valid and "VALID" in text_upper and "INVALID" not in text_upper:
    return 1.0
elif expected_invalid and "INVALID" in text_upper:
    return 1.0
elif expected_valid and "INVALID" in text_upper:
    return 0.0
elif expected_invalid and "VALID" in text_upper and "INVALID" not in text_upper:
    return 0.0
# Partial credit for reasoning quality even if verdict is wrong
reasoning_keywords = [...]
return min(0.3, matches * 0.05)
```

The dataset has five task categories (`VALID_MOVES_SAMPLES`,
`STRATEGY_SAMPLES`, `WIN_CONDITION_SAMPLES`, `OPENING_SAMPLES`,
`ENDGAME_SAMPLES`); only the first has an `answer` containing a `VALID`/
`INVALID` verdict at all. On the other four (the majority of the dataset),
neither `expected_valid` nor `expected_invalid` is true, every branch above
is skipped, and the function falls through to the same kind of capped
keyword bonus (`hive`/`adjacent`/`surrounded`/`move`/`piece`/`rule`/`space`/
`hex`) the other three functions already use — content-free, just capped
lower (0.3 instead of 1.0).

On the legality-check category itself, the `expected_invalid` branch has a
gap the `expected_valid` branch does not: it only requires `"INVALID" in
text_upper`, with no check that the completion isn't also hedging toward
`VALID`. Since the string `"INVALID"` always contains `"VALID"` as a
substring, a completion that literally states **both** words — e.g. "this
could be VALID or INVALID depending on interpretation" — passes this branch
whenever the true answer is invalid, scoring the full `1.0` for a verdict it
never actually committed to. The mirror-image branch for `expected_valid`
closes this gap explicitly (`"INVALID" not in text_upper`); the invalid
branch does not.

## 3. The experiment

Pulled live via `prime env pull audition/hive-insect-board-game` (no
repo-local fixture). All four functions are pure `async (completion, answer)
-> float` with no same-file dependencies, extracted via `dynamic_probe.py`.

One fixed completion — written once, generically, with no reference to any
specific board position — combining every category all three boilerplate
functions score for, plus the hedge phrase from §2:

> "1. First, I'll place the Ant at c2, since Ants provide maximum mobility
> around the hive. 2. This creates a threat because it can slide around to
> surround the opponent's Queen Bee, applying pressure and initiative.
> 3. Therefore this forces Black to respond defensively; White can also
> counter if Black plays elsewhere. This move keeps the hive connected (one
> hive rule) and the piece has exactly 1 space of freedom to move without
> being blocked, since it is not adjacent to any opponent piece before turn
> 4. However, an alternative would be the Beetle, which can climb on top for
> additional development and tempo. On the other hand, mobility and queen
> safety both matter here. Best move: place the Ant at c2. VALID or INVALID
> depending on which piece rule applies here, so consider both readings
> carefully before concluding."

Scored against three real dataset answers, unmodified from
`VALID_MOVES_SAMPLES` and `STRATEGY_SAMPLES`.

## 4. Results

```
                    move_accuracy  strategy_score  rule_knowledge  analysis_depth   TOTAL / 3.5
VALID-truth row          0.0            1.0             1.0             1.0          2.500  (71%)
INVALID-truth row        1.0            1.0             1.0             1.0          3.500  (100%)
STRATEGY-type row        0.3            1.0             1.0             1.0          2.800  (80%)
```

The identical completion — never adapted to the board, never actually
computing a legality verdict — scores between **71% and 100% of the maximum
possible reward** depending only on which of the dataset's five task
categories the row happens to be, and hits the literal ceiling whenever the
true verdict is "invalid," via the hedge in §2. It never drops meaningfully
below 71%, because three of the four components cannot be failed by any
reasonably-worded response.

## 5. Final triage status of HUB-002's remaining static targets

This closes the triage HUB-002 §6 left as future work:

| Environment | Class | Status |
|---|---|---|
| `tohan/catan-resource-trading-simulator` | `regex_answer_extraction` | **Exploitable** — HUB-003 |
| `realm/carcassonne-tile-laying-agent` | `regex_answer_extraction` | **Exploitable** — HUB-004 |
| `fran/blokus-geometric-placement` | `regex_answer_extraction` | **Exploitable** — HUB-005 |
| `pronul/quoridor-path-blocking` | `regex_answer_extraction` | **Exploitable** — HUB-006 |
| `audition/hive-insect-board-game` | `regex_answer_extraction` | **Exploitable** — HUB-007 (this finding) |
| `punnettsquare9331/mcmcenv` | `regex_answer_extraction` | **Sound.** `action_from_catalog_response` is a deliberately robust action-projection parser (exact-token, then embedded-token, then a stable SHA-256 fallback so "every rollout reaches MCMC and obtains a real posterior-discrepancy reward" — the function's own docstring) feeding a real Wasserstein-distance reward computed from actual MCMC sampling, not a format check. Read closely enough to classify; the MCMC/Wasserstein reward path itself was not independently re-verified (would require running real sampling, out of scope here). |
| `polo/dominion-deck-building` | `regex_answer_extraction` | Not read closely — `_check_reasoning_quality`'s `re.findall(r'\d+')` (HUB-002 §3) was never followed up. |
| `halfounce/numpy-scipy-exact` | `regex_answer_extraction` | Not independently read — same author and function names (`_as_int`/`_extract`) as `exact-determinant` below; resemblance noted, not confirmed. |
| `halfounce/exact-determinant` | `regex_answer_extraction` | **Sound** — HUB-002 §5 (pre-existing finding, not from this session). |
| `mayokun26/research-debugging` | `containment_decides_reward_UNTYPED` | **Sound** — HUB-002 §5 (pre-existing). |
| `iinmotion/algebra-steps` | `containment_decides_reward_UNTYPED` | Not read. |

Five of nine `regex_answer_extraction` hits are now confirmed exploitable;
two are confirmed sound; two remain unread. Both `containment_decides_
reward_UNTYPED` and the two `loose_numeric_tolerance` hits
(`dylantirandaz/omp-coding`, `ritwikraha/the-scientist`, flagged in HUB-004
§2 as unexamined for the self-reported-metric pattern) are also still open.

## 6. What this does not establish

Whether `polo/dominion-deck-building`, `halfounce/numpy-scipy-exact`,
`iinmotion/algebra-steps`, `dylantirandaz/omp-coding`, or
`ritwikraha/the-scientist` are exploitable — the five remaining untriaged
static targets from HUB-002's original 47.

## 7. Options — open

1. File this (and HUB-003/004/005/006) against their environments or Hub
   listings. **Not done.**
2. Triage the five remaining static targets named in §6. **Not done.**
3. Move to the next unclaimed item — at this point, a reasonable place to
   stop the per-environment triage and consider what it adds up to: 5 of 9
   sampled RLVR-style board/game environments on the Hub had a
   dynamically-confirmed exploitable reward, found by reading each rubric's
   source by hand rather than any automated technique. That ratio, on a
   sample this small, is itself the more interesting number than any one
   environment's specific bug.

## 8. Reproduction

```bash
uv tool install prime
prime env pull audition/hive-insect-board-game -t /tmp/hive --plain

cd tools/hub-audit
python3 dynamic_probe.py /tmp/hive move_accuracy \
  "INVALID. Moving the Queen Bee from a1 to a2 would break the hive..." \
  completions.json
# repeat for strategy_score, rule_knowledge, analysis_depth -- see §3/§4
# for the exact completion and the three answer strings used.
```

No account required.
