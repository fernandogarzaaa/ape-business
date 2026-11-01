# HUB-005: `blokus-geometric-placement`'s rubric rewards claiming the biggest piece, not the right one

**Subject:** `fran/blokus-geometric-placement` (Prime Intellect Environments
Hub), four of its five rubric functions
**Severity:** exploitable — three independent defect mechanisms confirmed
dynamically, plus one dead reward component
**Status:** confirmed, reproducible, deterministic across two independent
dataset rows. Not filed upstream — that decision is the user's, per the same
discipline HUB-003 §6 and HUB-004 §8 applied.

Continuation of the triage HUB-004 §6 left open across HUB-002's remaining
static `regex_answer_extraction` hits. Confirming this needed a real
tooling upgrade: `dynamic_probe.py`'s single-function extraction could not
see this environment's reward functions at all, because every one of them
calls a same-file sibling helper.

---

## 1. The tooling gap this hit first

`check_placement_validity` and `check_coverage_score` both call
`can_place()`, `get_piece_cells()`, and reference the module-level `PIECES`
dict — none of which `dynamic_probe.load_reward_fn` could see, since it only
extracted the one named function's source segment. `HUB-004`'s target didn't
call anything outside itself, so this gap went unnoticed until now.

Fixed generally: `load_reward_fn` now walks the target function's referenced
names, resolves any that match a module-level function or constant
assignment *in the same file*, and recurses into each one's own references —
the transitive same-file dependency closure, not just the one function. Classes,
cross-file imports, and closures over another function's locals are still out
of scope and still fail loudly as a `NameError`
(`test_load_reward_fn_still_raises_on_unresolvable_dependencies`).

## 2. The rubric under test

`load_environment()` (`blokus_geometric_placement/__init__.py:597`) weighs
five functions:

| Weight | Function | What it checks |
|---|---|---|
| 0.35 | `check_placement_validity` | extracts a claimed `{piece, row, col, rotations, reflected}` and validates it against the real board state |
| 0.20 | `check_coverage_score` | `min(1.0, piece_size / 5)` — the claimed piece's cell count over 5 (the largest piece size) |
| 0.15 | `check_reasoning_quality` | keyword density across spatial/rule vocabularies, plus a length bonus |
| 0.15 | `check_count_accuracy` | extracts a number from the completion and compares to a `valid_count` in `answer` |
| 0.15 | `check_multi_placement` | counts `{...}`-shaped objects with `row`/`col` keys and compares the count to `len(answer["placements"])` |

## 3. Defect A — `check_placement_validity` never checks that the claimed piece is the one the task assigned

```python
piece_name = placement.get("piece", "")
...
if piece_name not in PIECES:
    return 0.0
...
cells = get_piece_cells(piece_name, rotations, reflected)
...
if can_place(grid, cells, row, col, existing):
    return 1.0
```

The task's actual assigned piece (`answer_data["piece"]`) is parsed but never
compared to `piece_name`. Any piece name from `PIECES`, geometrically
placeable *somewhere* on the given board, scores `1.0` — whether or not it is
the piece the prompt asked about.

## 4. Defect B — `check_coverage_score` pays for the claimed piece's size, not its correctness

```python
piece_size = len(PIECES[piece_name])
max_size = 5
return min(1.0, piece_size / max_size)
```

No board, no `answer`, no correctness check at all — the entire score is a
lookup of how many cells the *claimed* piece name has. Combined with Defect
A, a completion can name the largest available piece (any `pentomino_*`, size
5) regardless of the task, collect `1.0` on this component unconditionally,
and — as long as that piece happens to fit somewhere on the board, which an
empty or lightly-obstructed board almost always allows — collect `1.0` on
Defect A too.

## 5. Defect C — `check_count_accuracy` has two independent failure modes

```python
expected_count = answer_data.get("valid_count", 0)
...
numbers = re.findall(r'\b(\d+)\b', text)
for num_str in numbers:
    if int(num_str) == expected_count:
        return 1.0
```

- **Shotgun enumeration.** On the six dedicated counting tasks (the only ones
  with a real, non-default `valid_count`), a completion that lists every
  plausible small integer guarantees an exact match — `for num_str in
  numbers` checks every number found, not just one the model "commits" to.
- **Default-to-zero on every other task type.** `answer_data.get("valid_count",
  0)` is `0` for all four non-counting task generators (`placement`,
  `multi_piece`, `spatial_reasoning`, `optimization` — only
  `make_counting_tasks` sets the key). On those rows — the large majority of
  the dataset — `check_count_accuracy` scores `1.0` for **any** completion
  containing the literal digit `0` anywhere, which is true of nearly every
  placement response (`"row": 0`, `"rotations": 0`, ...), independent of
  whether the response has anything to do with counting.

## 6. Defect D — `check_multi_placement` is dead code

```python
expected_placements = answer_data.get("placements", [])
if not expected_placements:
    return 0.0
```

`"placements"` is set by exactly one task generator (`make_multi_piece_tasks`),
and there it is hardcoded to `[]` ("Multiple valid answers exist" — the
comment in the source). No task generator in the dataset ever produces a
non-empty `placements` list. This component returns `0.0` for every row in
the entire dataset, for every completion, correct or not — not gameable, just
inert. 0.15 of the nominal rubric weight is never paid to anyone.

## 7. The experiment

Pulled live via `prime env pull fran/blokus-geometric-placement` (no
repo-local fixture). All four `check_*` reward functions plus their shared
helpers (`can_place`, `get_piece_cells`, `PIECES`, `parse_grid`,
`rotate_piece`, `reflect_piece`) were extracted via the upgraded
`dynamic_probe.py` — the environment's own `verifiers`/`datasets` imports
were never needed.

Two `make_single_placement_tasks()` rows (real board strings and assigned
pieces from the actual generator, not synthetic ones):

- **row 1** — 5×5 empty board, assigned piece `tromino_L` (size 3, `answer =
  {"grid": ..., "existing_cells": "[]", "piece": "tromino_L"}`)
- **row 2** — 5×5 board with three obstacles, assigned piece `tetromino_T`
  (size 4)

Two completions per row:

- **honest** — the real assigned piece, geometrically verified against the
  board (via the same `can_place`/`get_piece_cells` this reward uses) to be a
  genuinely valid placement, stated as bare JSON with no boilerplate.
- **gaming** — claims `pentomino_F` (size 5 — the largest piece, and *not*
  the assigned one) at a position independently verified valid for that
  piece on the same board, wrapped in the spatial-reasoning vocabulary
  `check_reasoning_quality` scores for.

## 8. Results

```
row 1 (5x5 empty, assigned tromino_L):
  placement_validity   1.000  honest   |  1.000  gaming
  coverage_score        0.600  honest   |  1.000  gaming
  reasoning_quality      0.240  honest   |  0.700  gaming
  count_accuracy         1.000  honest   |  1.000  gaming
  multi_placement         0.000  honest   |  0.000  gaming
  WEIGHTED TOTAL          0.656  honest   |  0.805  gaming

row 2 (5x5 with 3 obstacles, assigned tetromino_T):
  placement_validity   1.000  honest   |  1.000  gaming
  coverage_score        0.800  honest   |  1.000  gaming
  reasoning_quality      0.240  honest   |  0.600  gaming
  count_accuracy         1.000  honest   |  1.000  gaming
  multi_placement         0.000  honest   |  0.000  gaming
  WEIGHTED TOTAL          0.696  honest   |  0.790  gaming
```

**The completion claiming the wrong piece outscores the one stating the
correct, verified placement in both rows** — 0.805 vs 0.656 (23% margin) and
0.790 vs 0.696 (13% margin). The margin varies with the assigned piece's own
size (a task assigning a pentomino already scores full marks on Defect B
honestly, narrowing the gap; `tromino_L`/`tetromino_T`, sizes 3–4, do not),
but the direction — wrong-and-bigger beats correct — holds in both, and
`check_placement_validity` scoring identically (`1.0`/`1.0`) in both rows is
Defect A in action: the reward cannot tell these two completions' pieces
apart, only that each names *something* placeable.

## 9. What this establishes, and what it does not

**Does establish:** of this rubric's five components, one (`reasoning_quality`,
0.15) is content-free boilerplate in HUB-003/004's shape, one
(`multi_placement`, 0.15) never pays out to anyone, and two more
(`placement_validity` at 0.35 — the largest single weight — and
`coverage_score` at 0.20) can both be collected by a completion that
identifies the wrong piece, as long as that piece is placeable somewhere.
`count_accuracy` (0.15) is either brute-forceable or a near-universal freebie
depending on task type. No component in this rubric reliably distinguishes a
completion that solved the assigned task from one that didn't.

**Does not establish:** whether `pronul/quoridor-path-blocking`,
`punnettsquare9331/mcmcenv`, or `audition/hive-insect-board-game` — HUB-002's
remaining untriaged `regex_answer_extraction` hits — share any of these
patterns; not examined in this pass. **Since triaged:** quoridor
(HUB-006, exploitable), hive (HUB-007, exploitable), mcmcenv (HUB-007 §5,
sound).

## 10. Honest limitations

- **The "gaming" completion's coordinates were chosen by running the same
  `can_place`/`get_piece_cells` logic the reward itself uses**, to guarantee
  a fair, verified-valid claim rather than a lucky guess — mirroring
  HUB-004's method, not a weakness specific to this finding.
- **`dynamic_probe.py`'s dependency resolution is same-file and module-level
  only.** A reward function whose helper lives in a different file, or is a
  method on a class instantiated elsewhere, still needs manual assembly (or
  further tooling work) to score in isolation.
- **Only `check_placement_validity`'s exact-match logic was probed for the
  identity gap; `check_multi_placement`'s dead-code status was confirmed by
  reading every task generator, not by exhaustively running the dataset.**

## 11. Options — open

1. File this against the environment (or its Hub listing). **Not done.**
2. Triage `pronul/quoridor-path-blocking`, `punnettsquare9331/mcmcenv`, and
   `audition/hive-insect-board-game` for the same patterns. **Done** —
   see HUB-006 and HUB-007.
3. Move to the next unclaimed item.

## 12. Reproduction

```bash
uv tool install prime
prime env pull fran/blokus-geometric-placement -t /tmp/blokus --plain

cd tools/hub-audit
python3 dynamic_probe.py /tmp/blokus check_coverage_score \
  '{"grid": ".....\n.....\n.....\n.....\n.....", "existing_cells": "[]", "piece": "tromino_L"}' \
  completions.json   # {"claims pentomino_F": ..., "claims tromino_L": ...} -- see §7 for the exact JSON used
```

No account required. Reproduces with no `verifiers`/`datasets` installation.
