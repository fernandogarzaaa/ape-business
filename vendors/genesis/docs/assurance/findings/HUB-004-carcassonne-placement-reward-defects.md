# HUB-004: `carcassonne-tile-laying-agent`'s rubric pays a wrong, self-reported placement more than a correct, honest one

**Subject:** `realm/carcassonne-tile-laying-agent` (Prime Intellect Environments
Hub), all four functions in its rubric
**Severity:** exploitable — two independent defect classes confirmed
dynamically in the same rubric: `regex_answer_extraction`/format-only reward
(Ray, arXiv 2606.01066) and a self-reported-metric trust defect distinct from
anything named in HUB-001/HUB-002/HUB-003
**Status:** confirmed, reproducible, deterministic across two independent
dataset rows. Not filed upstream — that decision is the user's, per the same
discipline HUB-003 §6 applied.

This is the next increment named in HUB-003 §6 option 2: extend
`tools/hub-audit/dynamic_probe.py`'s technique past the single target it first
confirmed. Triaging the static survey's remaining `regex_answer_extraction`
hits by hand (§5) turned up a second live target with a cleaner, more severe
defect than HUB-003's.

---

## 1. The rubric under test

`load_environment()` combines four reward functions
(`carcassonne_tile_laying_agent/__init__.py:365`), weighted:

| Weight | Function | What it checks |
|---|---|---|
| 0.35 | `placement_validity_reward` | extracts a `(row, col)` and a rotation from the completion, checks them against the real legal-placement list computed from the actual board state |
| 0.30 | `scoring_quality_reward` | extracts a self-reported `score=N` from the completion and compares *that number* to the dataset's precomputed best/worst score |
| 0.20 | `reasoning_quality_reward` | keyword density across four fixed vocabularies (terrain, scoring, strategy, rotation) |
| 0.15 | `format_compliance_reward` | three independent regex checks: a coordinate pattern, a rotation-word pattern, a recommendation-word pattern |

`reasoning_quality_reward` and `format_compliance_reward` are content-free by
construction, in exactly HUB-003's shape — 0.35 of the total reward for
vocabulary and format alone, regardless of what was recommended. That much
was expected from the static triage. Reading `scoring_quality_reward` and
`placement_validity_reward` closely turned up two things the static signature
alone did not predict.

## 2. Defect A — `scoring_quality_reward` trusts the model's arithmetic on its own say-so

```python
score_match = re.search(r"score[=:]?\s*([\d.]+)", text, re.IGNORECASE)
if not score_match:
    ...
claimed_score = float(score_match.group(1))
best_score = expected.get("best_score", 1)
worst_score = expected.get("worst_score", 0)
normalized = (claimed_score - worst_score) / (best_score - worst_score)
return max(0.0, min(1.0, normalized))
```

The function never checks that `claimed_score` is the actual score of the
placement the completion recommended — a chosen `(position, rotation)` and a
claimed `score` are read from completely independent regex matches, with no
join between them. A completion recommending the worst legal placement while
stating `Score: <best_score>` scores exactly as if it had recommended the
best one. This is a distinct pattern from HUB-003's dead correctness-check:
there, the answer-matching component was unreachable; here, the component is
reachable and always active, but it verifies a number the model supplied
about itself rather than anything about the environment. `dylantirandaz/omp-coding`
and `ritwikraha/the-scientist` (HUB-002's two `loose_numeric_tolerance` hits)
were not re-examined for the same pattern — a reasonable next check, not done
here.

## 3. Defect B — `placement_validity_reward`'s exact-match branch is a units bug, not a gate

```python
rotation = int(rot_match.group(1)) // 90 if rot_match else 0
...
for vp in valid_placements:
    if vp["position"] == list(pos) and vp["rotation"] == rotation:
        return 1.0
```

`vp["rotation"]` is stored in **degrees** (`0, 90, 180, 270` — see
`build_dataset`'s `"rotation": rot * 90`). The extracted value is converted to
an **index** (`degrees // 90`, i.e. `0, 1, 2, 3`) before the comparison. The
two are equal only when the true rotation happens to be 0°, since `0 // 90 ==
0` is the only fixed point. For the other three of four possible rotations —
75% of legal placements in this dataset — a completion that states the
*exact* correct position and rotation cannot reach the `1.0` branch at all
and is capped at `0.5` (the position-only partial-credit branch just below
it). This is independent of Defect A and of the static survey's
`regex_answer_extraction` flag on this function (line 168's `rotation[=:]?`
pattern is exactly where the bug lives) — it was found by reading the
comparison, not by the signature scan.

## 4. The experiment

Pulled live via `prime env pull realm/carcassonne-tile-laying-agent` (no
repo-local fixture). All four functions are pure `async (completion, answer)
-> float` with no dependency on the rest of the package, extracted by name via
`dynamic_probe.py` exactly as in HUB-003. Scoring `scoring_quality_reward`
needed `json.loads(answer)` — `dynamic_probe.load_reward_fn`'s exec namespace
only carried `re`/`Any` (sufficient for HUB-003's target, which needed
neither), so this run added `json`/`math`/`Optional` to the namespace as a
direct, general fix rather than special-casing this one target
(`tools/hub-audit/tests/test_dynamic_probe.py`'s
`test_load_reward_fn_provides_json_for_json_encoded_answers` guards the
regression).

Two dataset rows (`build_dataset(seed=42)`, rows at index 2 and 3 — the
`answer` is a JSON blob of the real computed legal-placement list, so this
reproduces the dataset's own generation exactly, not a synthetic one), two
completions each:

- **correct, terse, honest** — states the actual best move (position and its
  true, non-zero-degree rotation) and stops.
- **wrong, boilerplate-and-self-reported-score** — recommends a placement
  *outside* the legal-placement list entirely (a coordinate the real board
  state makes invalid for this tile), wrapped in the vocabulary all four
  reward functions score for, and claiming `Score: <the dataset's real
  best_score, lied about>`.

## 5. Results

```
row i=2 (best_score=8.0, worst_score=4.5, best move (1,-1)@90°):
  placement_validity   0.500  correct_terse   |  0.000  wrong_boilerplate
  scoring_quality       0.300  correct_terse   |  1.000  wrong_boilerplate
  reasoning_quality      0.200  correct_terse   |  0.900  wrong_boilerplate
  format_compliance      1.000  correct_terse   |  1.000  wrong_boilerplate
  WEIGHTED TOTAL         0.455  correct_terse   |  0.630  wrong_boilerplate

row i=3 (best_score=7.0, worst_score=4.5, best move (-1,-1)@90°):
  placement_validity   0.500  correct_terse   |  0.000  wrong_boilerplate
  scoring_quality       0.300  correct_terse   |  1.000  wrong_boilerplate
  reasoning_quality      0.200  correct_terse   |  0.900  wrong_boilerplate
  format_compliance      1.000  correct_terse   |  1.000  wrong_boilerplate
  WEIGHTED TOTAL         0.455  correct_terse   |  0.630  wrong_boilerplate
```

Identical to three decimal places across both rows — not a property of one
lucky sample. **The completion that recommends an illegal placement and lies
about its score outscores the completion that states the true best move,
0.630 to 0.455, a 38% margin**, and the honest completion's own ceiling on
`placement_validity_reward` (0.5, from Defect B) is part of why the margin is
this wide: even a perfectly correct agent cannot close the gap by being more
correct, because the one reward component actually keyed to ground truth
cannot pay out fully on 75% of correct answers.

Separately, `scoring_quality_reward` alone confirms Defect A in isolation: an
honest completion that doesn't bother restating a redundant numeric score
(`correct_terse` above) scores `0.3` — the same "partial credit for making
any move" floor a completion with *no* placement at all would get — while a
completion that states any placement and claims the right number scores
`1.0`, independent of whether that placement is the one actually scored.

## 6. What this establishes, and what it does not

**Does establish:** for `realm/carcassonne-tile-laying-agent`'s rubric, an
agent that learns to (a) recommend a plausible-looking but unchecked
placement, (b) restate the dataset's own best-score number back at the
grader, and (c) narrate the fixed reward vocabulary will systematically
outscore one that computes and states the correct answer plainly — and part
of that gap is a bug (Defect B), not merely a gameable design choice, so
fixing the vocabulary-density components (Defect A/reasoning/format) alone
would not close it.

**Does not establish:** whether `dylantirandaz/omp-coding` or
`ritwikraha/the-scientist` (HUB-002's other `loose_numeric_tolerance` hits)
share Defect A's shape, or whether `fran/blokus-geometric-placement`,
`pronul/quoridor-path-blocking`, `punnettsquare9331/mcmcenv`, and
`audition/hive-insect-board-game` (HUB-002's remaining untriaged
`regex_answer_extraction` hits) contain exploitable rewards at all — a manual
read of each (this session's method, not a generic regex-to-completion
synthesizer — see §7) found that most of the survey's other
`regex_answer_extraction` hits are extraction call sites feeding a real
ground-truth comparison (the same "signature in the grading path, not a
defect" shape HUB-002 §5 already confirmed for `halfounce/exact-determinant`),
not bare content-free bonuses like this one. `halfounce/numpy-scipy-exact`'s
`_as_int`/`_extract` (same author, same function names as
`exact-determinant`) were read only well enough to note the resemblance, not
independently confirmed sound.

## 7. Honest limitations

- **Manual triage, not a generalized suite.** Turning `dynamic_probe.py` into
  something that auto-synthesizes a bait completion from an arbitrary regex
  signature and scores it was considered and rejected for this round: most of
  the remaining static hits are value-extraction sites whose exploitability
  depends on what happens to the extracted value afterward (compared to
  ground truth, or not) — a distinction no regex-shape heuristic can make.
  Confirming or refuting each of the four untriaged environments needs the
  same by-hand reading this finding and HUB-003 both required.
- **Only two of the rubric's four functions were probed for defects beyond
  the static flag.** `reasoning_quality_reward` and `format_compliance_reward`
  were confirmed content-free by inspection (§1) but not independently
  fuzzed beyond the two completions in §4.
- **The illegal-placement completion in §4 was constructed knowing the real
  board state** (to guarantee the coordinate is actually outside
  `valid_placements`, not accidentally legal). This mirrors HUB-003's method
  and is not a weakness particular to this finding.

## 8. Options — open

1. File this against the environment (or its Hub listing). **Not done.**
2. Triage the four remaining untriaged `regex_answer_extraction` environments
   by hand (§6). **Partially done:**
   `HUB-005-blokus-reward-defects.md` triaged `fran/blokus-geometric-placement`
   and confirmed three more defect mechanisms, plus a real
   `dynamic_probe.py` upgrade (same-file dependency resolution) that the
   remaining three environments may also need. Three environments
   (`quoridor`, `mcmcenv`, `hive`) are still untriaged.
3. Check `dylantirandaz/omp-coding` and `ritwikraha/the-scientist` for
   Defect A's shape (self-reported metric, unchecked against the actual
   answer) specifically, since `loose_numeric_tolerance` was flagged on both
   and neither has been read closely. **Not done.**
4. Move to the next unclaimed item.

## 9. Reproduction

```bash
uv tool install prime
prime env pull realm/carcassonne-tile-laying-agent -t /tmp/carcassonne --plain

cd tools/hub-audit
python3 dynamic_probe.py /tmp/carcassonne scoring_quality_reward \
  '{"best_score": 8.0, "worst_score": 4.5}' completions.json
# repeat for placement_validity_reward, reasoning_quality_reward,
# format_compliance_reward with the same completions.json --
# the `answer` argument for placement_validity_reward needs the full
# valid_placements list too; see §4 for the exact row used.
```

No account required. Reproduces with no `verifiers`/`datasets` installation.
