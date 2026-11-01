# HUB-006: `quoridor-path-blocking`'s entire rubric never reads the answer — one fixed reply scores a perfect 1.0 on every task

**Subject:** `pronul/quoridor-path-blocking` (Prime Intellect Environments
Hub), all five functions in its rubric
**Severity:** exploitable — the most severe pattern in this series: not
"gaming outscores correctness" but **zero access to a checkable ground
truth, by construction**. Ray's taxonomy (arXiv 2606.01066) doesn't have a
clean name for "the reward function's `answer` parameter is dead code across
the entire rubric" — closest is `regex_answer_extraction`/format-only reward,
generalized to the whole grader rather than one component of it.
**Status:** confirmed, reproducible, deterministic, and provable by static
inspection alone (§2) independent of the dynamic run in §4. Not filed
upstream — that decision is the user's, per the same discipline HUB-003 §6
applied.

Continues the triage HUB-005 §9 left open. This is the strongest result in
the series: HUB-003/004/005 each found *some* reward component that checks
real state, alongside others that don't. This environment has none.

---

## 1. The rubric under test

`load_environment()` (`quoridor_path_blocking/__init__.py:413`) combines five
reward functions, weighted 0.25/0.25/0.20/0.15/0.15:

| Weight | Function | What it checks |
|---|---|---|
| 0.25 | `check_move_format` | does the text contain `MOVE:`/`WALL:` in the right notation shape |
| 0.25 | `check_strategic_reasoning` | keyword density (path words, block words, opponent words) plus a length floor |
| 0.20 | `check_path_calculation` | does the text contain `P1`/`Player 1` near a number near "moves"/"steps", ditto for P2, plus the literal word "advantage" |
| 0.15 | `check_wall_reasoning` | does the text contain a wall-notation pattern plus strategy/opponent keywords |
| 0.15 | `check_overall_quality` | word count in range, contains a newline, mentions a rules term, avoids a hallucination term |

## 2. The proof that needs no dynamic run at all

Every one of these five functions takes `(completion, answer, **kwargs)`.
None of them reference `answer` anywhere in its body:

```
$ awk '/^async def check_/,/^def load_environment/' quoridor_path_blocking/__init__.py | grep -n answer
1:async def check_move_format(completion, answer, **kwargs):
28:async def check_strategic_reasoning(completion, answer, **kwargs):
63:async def check_path_calculation(completion, answer, **kwargs):
93:async def check_wall_reasoning(completion, answer, **kwargs):
123:async def check_overall_quality(completion, answer, **kwargs):
```

`answer` appears exactly once per function — in its own signature. This is
provable by inspection, independent of any dynamic probe: **the reward this
rubric computes cannot, as written, depend on which puzzle was asked or what
the correct move is.**

It goes a level deeper. `_generate_puzzle` (line 53) is what builds each
dataset row's `answer`:

```python
answer = json.dumps({
    "p1_pos": _pos_to_algebraic(*p1),
    "p2_pos": _pos_to_algebraic(*p2),
    "num_walls": num_walls,
    "type": "best_move",
})
```

This is not merely unused — it does not encode a correct answer to begin
with. There is no shortest-path solver, no best-move search, no BFS anywhere
in the module (confirmed by grep: the only occurrences of "BFS"/"shortest
path" are inside the system prompt, *instructing the model* to do that
calculation). `answer` records the starting positions and puzzle type, not a
verified ground truth. Fixing `check_path_calculation` or `check_move_format`
to actually check correctness would require building a solver this
environment does not have anywhere — not a reward-function bug fixable by
editing five functions, but a missing piece of the environment itself.

## 3. What each component actually rewards

- `check_move_format`: literal string `MOVE: e5` (or `WALL: c3 horizontal`)
  anywhere in the text. `re.search(r'MOVE:\s*[a-i][1-9]', ...)`.
- `check_strategic_reasoning`: any of `path/route/shortest/distance/moves/steps`,
  any of `block/wall/obstruct/delay/force/redirect`, any of
  `opponent/player 1/player 2/they/their`, and >100 chars of text in lines
  longer than 20 chars. All four are keyword/length checks with no relation
  to the board.
- `check_path_calculation`: a number near "P1"/"Player 1" near "moves" or
  "steps" (any number — `4`, `400`, `-1` all match `\d+`), ditto for P2, plus
  the literal substring "advantage". Never computes or checks an actual path
  length.
- `check_wall_reasoning`: a wall-notation-shaped string, plus strategy
  keywords, plus opponent keywords. Independent of whether a wall was
  actually the better move, or whether the stated wall is a legal placement.
- `check_overall_quality`: word count band, presence of a newline, one rules
  term, absence of four "hallucination" terms (`diagonal`, `jump over`,
  `multiple squares`, `knight` — none of which are real Quoridor moves, so
  this only screens for a specific set of wrong-game confusions, not general
  correctness).

Notably, `check_move_format` and `check_wall_reasoning` are independent
functions with no shared state: a completion can state both a `MOVE:` and a
`WALL:` recommendation in the same turn — something no legal single Quoridor
turn can be (a turn is one or the other) — and collect full credit on both,
since neither function checks the other's output or that exactly one action
was taken.

## 4. The experiment

Pulled live via `prime env pull pronul/quoridor-path-blocking` (no
repo-local fixture). All five functions are pure `async (completion, answer)
-> float` with no dependency on the rest of the package, extracted via
`dynamic_probe.py`. One dataset row was generated by extracting
`_generate_puzzle` and its helpers the same way (AST source-segment
extraction, no `verifiers`/`datasets` import) to get a real, freshly
generated `answer` rather than a synthetic one — though per §2 this is
provably unnecessary, since no function reads it.

Two completions, scored against that real `answer`:

- **blank** — `"I don't know."`
- **canned boilerplate** — a single fixed paragraph, written once, with no
  reference to the actual board, positions, or walls in the prompt: states
  arbitrary P1/P2 move counts, a `MOVE: e5`, a `WALL: c3 horizontal`, and the
  keyword vocabulary all five functions check for.

## 5. Results

```
                          blank    canned_boilerplate
check_move_format         0.000    1.000
check_strategic_reasoning 0.000    1.000
check_path_calculation    0.000    1.000
check_wall_reasoning      0.000    1.000
check_overall_quality     0.250    1.000
WEIGHTED TOTAL             0.038    1.000
```

**The canned completion scores the literal maximum, 1.000, on a real dataset
row it never looked at.** This is not "outscores a correct answer" the way
HUB-003/004/005 confirmed — there is no correct-answer branch to outscore.
One fixed string, written before ever seeing a single puzzle, saturates the
entire reward on every row in the dataset, because every row's `answer` is
ignored identically. Re-running against `answer` values from the other two
puzzle types (`wall_placement`, `path_analysis`) is unnecessary to confirm
this — §2 already establishes it cannot vary by row, since none of the five
functions branch on `kwargs` or inspect anything besides `completion`.

## 6. What this establishes, and what it does not

**Does establish:** this rubric provides no training signal correlated with
Quoridor competence at all. An agent (or a human writing a canned response
by hand) that never parses the board, never computes a path, and never
checks a move's legality scores identically to — and in practice, given how
narrowly its own scenario-specific numbers must land inside the format
checks, probably higher than — one that actually plays the game. Every
component is satisfiable by surface form alone, and the dataset does not
even contain a computed ground truth answer to check against, so no
patch to the reward functions alone can fix this without also adding a
solver to the environment.

**Does not establish:** whether `punnettsquare9331/mcmcenv` or
`audition/hive-insect-board-game` (HUB-002's two remaining untriaged
`regex_answer_extraction` hits) share this answer-independence pattern, or
any exploitable pattern at all — not yet read.

## 7. Honest limitations

- **A pure-format finding, confirmed by both static and dynamic evidence.**
  Unlike HUB-003/004/005, this does not need the wrong-vs-correct
  comparison technique those findings used, because there is no
  correctness check anywhere in the rubric to compare against. The static
  proof in §2 is arguably the stronger of the two; §4/§5 confirms it
  empirically rather than establishing it.
- **Did not check whether `verifiers.Rubric` itself does anything with the
  unused `answer` beyond passing it through** (e.g., logging, or a
  parser-level check upstream of the rubric functions). This is a property
  of `pronul/quoridor-path-blocking`'s own code, not of the `verifiers`
  library, and nothing in `load_environment` suggests otherwise, but the
  `vf.Parser()`/`vf.Rubric` internals were not audited here.

## 8. Options — open

1. File this against the environment (or its Hub listing). **Not done.**
2. Triage `punnettsquare9331/mcmcenv` and `audition/hive-insect-board-game`,
   HUB-002's last two untriaged `regex_answer_extraction` hits. **Not done.**
3. Move to the next unclaimed item.

## 9. Reproduction

```bash
uv tool install prime
prime env pull pronul/quoridor-path-blocking -t /tmp/quoridor --plain

cd tools/hub-audit
python3 dynamic_probe.py /tmp/quoridor check_move_format \
  '{"p1_pos": "d5", "p2_pos": "h7", "num_walls": 5, "type": "best_move"}' \
  completions.json
# repeat for check_strategic_reasoning, check_path_calculation,
# check_wall_reasoning, check_overall_quality -- any `answer` string
# produces identical results, per §2.
```

No account required.
