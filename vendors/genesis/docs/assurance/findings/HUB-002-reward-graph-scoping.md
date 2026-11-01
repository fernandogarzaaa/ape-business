# HUB-002: scoping defect detection to the reward call graph

**Subject:** the blocker named in `HUB-001` §6
**Result:** built and validated — 548 signature hits reduced to 47, with the
verified false-positive classes eliminated entirely
**Status:** working tool, `tools/hub-audit/`. Still static: it produces
*targets*, not findings.

---

## 1. What HUB-001 established

Static signature scanning over whole environment packages cannot measure
grading defects. An environment contains a task generator, a simulated user,
agent-facing tools, a CLI, tests and vendored dependencies; only the reward
function can hold a *reward* defect, and grep cannot tell them apart. Every
class checked by hand there was dominated by false positives, including a
`missing_timeouts` hit on a grader that **does** pass `timeout=900`.

The blocker it named: find reward functions structurally via AST and walk their
call graph. That is what this is.

## 2. Reward registration patterns, found not assumed

The design was grounded by reading real environments first. Four patterns
exist in the wild, and a locator built for the obvious one would have missed
half the hub:

| # | Pattern | Example |
|---|---|---|
| 1 | classic `verifiers` | `rubric = vf.Rubric(funcs=[my_reward], weights=[1.0])` |
| 2 | `verifiers.v1` decorator | `class T(vf.Task): @vf.reward(weight=0.6) async def answer_correct(...)` |
| 3 | cross-process | reward path shells out to a grader script the Python graph cannot follow |
| 4 | imperative | `trace.record_reward("wasserstein_reward", outcome.reward)` |

Pattern 2 was found only because two of the first five environments sampled had
no `Rubric` in their source at all. Pattern 4 was found only because three
environments still had no locatable root after patterns 1–3, and one was
investigated rather than written off as unsupported.

Pattern 3 is not resolvable by a Python call graph and is **reported rather
than silently missed** — `research-debugging`'s real grader is
`assets/hidden/verifier.py`, invoked via subprocess.

## 3. Results across the same 20 environments

| | Regex over whole package (HUB-001) | AST over reward graph |
|---|---|---|
| Functions examined | 6,338 | **171** (97% excluded) |
| Signature hits | 548 | **47** (91.4% reduction) |
| `stdout_trusted` | 3 envs — *0 of 5 hits real* | **0** |
| `llm_judge` | 2 envs — *0 of 2 hits real* | **0** |
| `missing_timeouts` | 3 envs — *the one that mattered was inverted* | **0** |
| `substring_match_grading` | 18 envs, 477 hits (288 `startswith`) | **2 envs**, demoted (§5) |
| Reward roots located | n/a | **19 / 20** |

The three classes verified as 100% false positives in HUB-001 are gone —
not tuned away, but excluded because the code they matched is not reachable
from any reward function.

What survives:

| Class | Envs | Note |
|---|---|---|
| `regex_answer_extraction` | 9/20 (45%) | Real targets; exploitability unproven (§5) |
| `containment_decides_reward_UNTYPED` | 2/20 | Deliberately low-confidence (§5) |
| `loose_numeric_tolerance` | 2/20 | |

Every surviving hit sits inside a function named `*_reward`, `check_*`,
`*_score`, `_extract` or `_as_int`. The signal is targeted in a way the regex
survey's was not.

## 4. The structural fix, concretely

HUB-001's worst error was flagging this as a missing timeout:

```python
result = subprocess.run(
    [sys.executable, str(HIDDEN_SRC / "verifier.py"), str(submission)],
    capture_output=True,
    text=True,
    timeout=900,          # present, on a line the regex could not see
    check=False,
)
```

A keyword lookup on the `ast.Call` node cannot make that mistake, and the
detector now reports zero missing timeouts across all 20 environments. Four of
HUB-001's ten hits were multi-line calls of exactly this shape.

`startswith`/`endswith` detection was deleted outright. It produced 288 of 477
hits and identified nothing.

## 5. Two disciplines that survived contact

**Untyped containment is demoted, not reported.** `research-debugging` returns
`0.0 if "diagnosis" in failed else 1.0` where `failed` is a **set**. That is
set membership, not substring grading, and flagging it would have repeated
HUB-001's mistake in a new place. `x in y` is indistinguishable between the two
without type inference, so the detector separates the provably-text case from
the ambiguous one and labels the latter `_UNTYPED`.

**A signature in the grading path is still not a defect.**
`halfounce/exact-determinant` is flagged `regex_answer_extraction` and remains
sound, as established in HUB-001 §5 and re-confirmed here: last-token-wins
allows exactly one attempt, the rejection floor makes `|g| ≤ 9999` never
correct at n≥5, and the grader recomputes the determinant exactly rather than
trusting a label. Scoping improved precision; it did not turn signatures into
findings.

Some remaining targets do look genuinely concerning — `tohan/catan`'s
`build_optimization_reward` calls
`re.search(r'remain|left|after|spend|use|cost')`, which rewards a completion
for *mentioning words*. That is a hypothesis worth probing, not a result.
**Probed and confirmed in `HUB-003-build-optimization-reward-gaming.md`:** a
wrong, boilerplate-stuffed build recommendation outscores a correct, terse
one, 2 to 1.

**A second target, probed and confirmed in
`HUB-004-carcassonne-placement-reward-defects.md`:**
`realm/carcassonne-tile-laying-agent`'s rubric has the same content-free-reward
shape plus an independent defect — a reward component that trusts a
self-reported score with no check against the actual placement, and a units
bug that caps the one ground-truth-checked component at half credit for 75%
of correct answers. A wrong, self-reported-score completion outscores a
correct, honest one 0.63 to 0.455.

**A third, probed and confirmed in `HUB-005-blokus-reward-defects.md`:**
`fran/blokus-geometric-placement`'s five-function rubric has one dead
component (never pays out to anyone) and two more that reward naming the
*biggest* available piece rather than the *correct* one — the
ground-truth-checked component included, which never verifies the claimed
piece matches the one the task assigned.

**A fourth, probed and confirmed in `HUB-006-quoridor-answer-independent-reward.md`:**
`pronul/quoridor-path-blocking`'s entire five-function rubric never reads its
`answer` parameter at all — provable by grep, not just by dynamic probe — so
one fixed, position-independent reply scores the literal maximum on every
task in the dataset.

**A fifth, probed and confirmed in `HUB-007-hive-boilerplate-reward.md`:**
`audition/hive-insect-board-game`'s rubric pays 71–100% of its maximum to the
same fixed reply regardless of position, and its one real correctness check
has a hedging loophole. That finding also completes the triage of every
`regex_answer_extraction` and `containment_decides_reward_UNTYPED` hit this
survey found reachable — see its §5 for the full scorecard: 5 of the 9
`regex_answer_extraction` hits are now confirmed exploitable, 2 confirmed
sound, 2 still unread, and both `containment_decides_reward_UNTYPED` hits
remain at one sound / one unread.

## 6. Honest limitations

- **Still static.** 47 targets, not 47 defects. Confirming any of them means
  constructing a completion that satisfies the pattern without doing the task
  and checking whether reward is granted — the dynamic step, and the one that
  needs model inference and rollouts for agentic environments.
- **1 of 20 has no locatable root.** `solar-sight/solar-eval` (58 modules, 422
  functions) uses none of the four patterns; it was not investigated further.
- **Cross-process graders are detected, not analyzed.** One environment shells
  out to its grader. Following that would mean analyzing the invoked script as
  a second entry point.
- **Name resolution falls back to a unique-match heuristic** when imports
  cannot be resolved exactly. It is conservative — ambiguous names resolve to
  nothing rather than to the wrong function — which under-reports rather than
  over-reports.
- **Reachability is over-approximate in the other direction**: a function
  called only on an error path counts as reachable.

## 7. Reproduction

```bash
uv tool install prime
cd tools/hub-audit
python3 reward_graph.py <pulled-env-dir>      # roots + call graph
python3 ast_signatures.py <pulled-env-dir>    # scoped signatures
python3 run_survey.py 20                      # pull + audit N envs
```

No account required.

## 8. Where this leaves the hub question

`05-COMPETITIVE-SCAN.md` asked for a defect rate. It is still unmeasured, and
this does not measure it — but it is now the *next* step rather than a blocked
one. The search space went from 6,338 functions to 171, and from 548 mostly
spurious hits to 47 targets sitting in named grading functions.

The remaining work is the dynamic probe, which is the same shape as everything
already in `src/assurance/`: construct a completion that satisfies the defect
but not the task, and see whether the grader pays out.
