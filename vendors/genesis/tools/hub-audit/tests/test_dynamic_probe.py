"""
Tests for dynamic_probe.py's function extraction and scoring.

The synthetic reward function below reproduces the exact shape that made
HUB-003 real: a small, task-relevant component (keyed on the true answer)
alongside larger flat components a buzzword-stuffed completion can win
regardless of correctness.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from dynamic_probe import FunctionNotFound, find_function_source, load_reward_fn, score_completions

GAMEABLE_REWARD = '''
import re

async def gameable_reward(completion, answer, **kwargs):
    text = completion[-1]["content"].lower()
    score = 0.0
    if answer.lower() in text:
        score += 0.4
    if re.search(r"remain|left|after", text):
        score += 0.6
    return score
'''

SYNC_REWARD = '''
def sync_reward(completion, answer, **kwargs):
    text = completion[-1]["content"].lower()
    return 1.0 if answer.lower() in text else 0.0
'''

# HUB-004's carcassonne-tile-laying-agent reward functions parse `answer` as
# JSON and trust a self-reported "score=N" claim with no cross-check against
# the placement actually described -- both require `json` in the exec
# namespace, which is the gap this test guards against regressing.
JSON_ANSWER_REWARD = '''
import json
import re

async def scoring_quality_reward(completion, answer, **kwargs):
    text = completion[-1]["content"]
    expected = json.loads(answer)
    match = re.search(r"score[=:]?\\s*([\\d.]+)", text, re.IGNORECASE)
    if not match:
        return 0.3
    claimed = float(match.group(1))
    best, worst = expected["best_score"], expected["worst_score"]
    return max(0.0, min(1.0, (claimed - worst) / (best - worst)))
'''


# HUB-005's blokus-geometric-placement reward functions call sibling
# module-level helpers (`can_place`, `get_piece_cells`) and reference a
# module-level constant (`PIECES`) -- none of which the single-function
# extraction this tool started with could see.
HELPER_DEPENDENT_REWARD = '''
import json

PIECES = {"mono": 1, "domino": 2, "pentomino": 5}


def piece_size(name):
    return PIECES.get(name, 0)


async def coverage_reward(completion, answer, **kwargs):
    claimed = json.loads(completion[-1]["content"])
    return min(1.0, piece_size(claimed["piece"]) / 5)
'''


def write(root: Path, name: str, source: str) -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)
    return path


def test_find_function_source_locates_across_files(tmp_path: Path) -> None:
    write(tmp_path, "unrelated.py", "def not_it(): pass\n")
    write(tmp_path, "pkg/env.py", GAMEABLE_REWARD)

    path, segment = find_function_source(tmp_path, "gameable_reward")

    assert path.name == "env.py"
    assert segment.startswith("async def gameable_reward")


def test_find_function_source_locates_methods_inside_classes(tmp_path: Path) -> None:
    write(
        tmp_path,
        "env.py",
        """
class Task:
    async def answer_correct(self, completion, answer, **kwargs):
        return 1.0
""",
    )

    _, segment = find_function_source(tmp_path, "answer_correct")
    assert "async def answer_correct" in segment


def test_find_function_source_raises_when_absent(tmp_path: Path) -> None:
    write(tmp_path, "env.py", "def other(): pass\n")
    with pytest.raises(FunctionNotFound):
        find_function_source(tmp_path, "missing_reward")


def test_load_reward_fn_skips_environment_dependencies(tmp_path: Path) -> None:
    """The real motivation: environments import `verifiers`/`datasets` at
    module scope, which this must not need in order to score one function."""
    write(
        tmp_path,
        "env.py",
        f"""
import verifiers as vf
from datasets import Dataset

{GAMEABLE_REWARD}
""",
    )

    fn = load_reward_fn(tmp_path, "gameable_reward")
    assert fn.__name__ == "gameable_reward"


def test_score_completions_confirms_the_exploit_pattern(tmp_path: Path) -> None:
    write(tmp_path, "env.py", GAMEABLE_REWARD)
    fn = load_reward_fn(tmp_path, "gameable_reward")

    scores = score_completions(
        fn,
        answer="1 city, 1 road",
        completions={
            "blank": "no idea",
            "correct, natural phrasing": "you should build 1 city, 1 road",
            "wrong build, buzzword-stuffed": "after using your resources, brick and wool remain",
        },
    )

    assert scores["blank"] == 0.0
    # The task-relevant component fires when the answer literally appears...
    assert scores["correct, natural phrasing"] == pytest.approx(0.4)
    # ...but a wrong, keyword-stuffed completion collects a *larger* score
    # from the flat component alone, untethered to correctness.
    assert scores["wrong build, buzzword-stuffed"] == pytest.approx(0.6)
    assert scores["wrong build, buzzword-stuffed"] > scores["correct, natural phrasing"]


def test_score_completions_accepts_sync_reward_functions(tmp_path: Path) -> None:
    write(tmp_path, "env.py", SYNC_REWARD)
    fn = load_reward_fn(tmp_path, "sync_reward")

    scores = score_completions(fn, answer="yes", completions={"a": "yes, absolutely", "b": "no"})

    assert scores == {"a": 1.0, "b": 0.0}


def test_load_reward_fn_provides_json_for_json_encoded_answers(tmp_path: Path) -> None:
    """Regression guard for the gap HUB-004's investigation hit: a reward
    function that does `json.loads(answer)` failed with a NameError before
    `json` was added to load_reward_fn's namespace."""
    write(tmp_path, "env.py", JSON_ANSWER_REWARD)
    fn = load_reward_fn(tmp_path, "scoring_quality_reward")

    answer = json.dumps({"best_score": 8.0, "worst_score": 4.5})
    scores = score_completions(
        fn,
        answer=answer,
        completions={"claims the best score": "Score: 8.0", "no claim": "no idea"},
    )

    assert scores["claims the best score"] == pytest.approx(1.0)
    assert scores["no claim"] == pytest.approx(0.3)


def test_load_reward_fn_resolves_same_file_helper_dependencies(tmp_path: Path) -> None:
    """Regression guard for the gap HUB-005's investigation hit: a reward
    function calling a sibling helper (which itself references a module-level
    constant) failed with a NameError before load_reward_fn resolved the
    same-file dependency closure rather than just the one named function."""
    write(tmp_path, "env.py", HELPER_DEPENDENT_REWARD)
    fn = load_reward_fn(tmp_path, "coverage_reward")

    scores = score_completions(
        fn,
        answer="irrelevant",
        completions={
            "claims the biggest piece": json.dumps({"piece": "pentomino"}),
            "claims the smallest piece": json.dumps({"piece": "mono"}),
        },
    )

    assert scores["claims the biggest piece"] == pytest.approx(1.0)
    assert scores["claims the smallest piece"] == pytest.approx(0.2)


def test_load_reward_fn_still_raises_on_unresolvable_dependencies(tmp_path: Path) -> None:
    """The dependency closure only reaches module-level defs/assignments in
    the same file -- a name it truly cannot resolve (an import, a helper
    defined inside another function) must still fail loudly, not silently
    produce a function that behaves differently than the real environment's."""
    write(
        tmp_path,
        "env.py",
        """
async def broken_reward(completion, answer, **kwargs):
    return some_undefined_helper(completion)
""",
    )
    fn = load_reward_fn(tmp_path, "broken_reward")

    with pytest.raises(NameError):
        score_completions(fn, answer="x", completions={"a": "text"})
