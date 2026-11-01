"""
Tests for reward_graph.py's AST-parsing core.

Two of these (`test_rubric_name_bound_list_is_resolved` and the
`subprocess_escape` block) are regression tests for the two real bugs fixed
alongside this file -- see HUB-002 and the reward_graph.py docstring.
"""
from __future__ import annotations

from pathlib import Path

from ast_signatures import audit
from reward_graph import analyze


def write(root: Path, name: str, source: str) -> None:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)


# ── Rubric(funcs=...) resolution ─────────────────────────────────────────────


def test_rubric_inline_list_literal_is_resolved(tmp_path: Path) -> None:
    """The pre-existing case: an inline `funcs=[...]` literal."""
    write(
        tmp_path,
        "env.py",
        """
def grade_a(): pass
def grade_b(): pass

def build():
    return vf.Rubric(funcs=[grade_a, grade_b], weights=[1.0, 1.0])
""",
    )
    result = analyze(tmp_path)
    names = {r["function"] for r in result["reward_roots"]}
    assert names == {"grade_a", "grade_b"}
    assert result["unresolved"] == []


def test_rubric_name_bound_list_is_resolved(tmp_path: Path) -> None:
    """
    HUB-002 bug: `funcs = [a, b]` assigned earlier, then `Rubric(funcs=funcs)`.
    This is the exact pattern in solar-sight/solar-eval's env.py:664, which
    made that environment show up as "unresolved" in the hub survey before
    this fix -- `_iter_list` only understood an inline literal.
    """
    write(
        tmp_path,
        "env.py",
        """
def grade_a(): pass
def grade_b(): pass

def build():
    funcs = [grade_a, grade_b]
    return vf.Rubric(funcs=funcs)
""",
    )
    result = analyze(tmp_path)
    names = {r["function"] for r in result["reward_roots"]}
    assert names == {"grade_a", "grade_b"}
    assert result["unresolved"] == []


def test_rubric_unresolvable_name_still_reports_unresolved(tmp_path: Path) -> None:
    """No matching assignment anywhere in the module: still reported, not guessed."""
    write(
        tmp_path,
        "env.py",
        """
def build(funcs):
    return vf.Rubric(funcs=funcs)
""",
    )
    result = analyze(tmp_path)
    assert result["reward_roots"] == []
    assert any(u["name"] == "funcs" for u in result["unresolved"])


def test_rubric_name_bound_list_uses_the_last_assignment(tmp_path: Path) -> None:
    write(
        tmp_path,
        "env.py",
        """
def grade_a(): pass
def grade_b(): pass

def build():
    funcs = [grade_a]
    funcs = [grade_b]
    return vf.Rubric(funcs=funcs)
""",
    )
    result = analyze(tmp_path)
    names = {r["function"] for r in result["reward_roots"]}
    assert names == {"grade_b"}


# ── @vf.reward decorator pattern (regression guard, untouched by this fix) ──


def test_decorator_pattern_still_resolves(tmp_path: Path) -> None:
    write(
        tmp_path,
        "task.py",
        """
class T:
    @vf.reward(weight=0.6)
    async def answer_correct(self):
        pass
""",
    )
    result = analyze(tmp_path)
    assert result["reward_roots"][0]["function"] == "T.answer_correct"


# ── subprocess escape resolution ─────────────────────────────────────────────


def test_subprocess_escape_resolves_and_scans_the_invoked_script(tmp_path: Path) -> None:
    """
    HUB-002 bug: a reward path that shells out to a grader script was recorded
    as an escape but never followed, so ast_signatures.py never scanned the
    file where the actual grading logic (and its defects) lives -- exactly
    research-debugging's assets/hidden/verifier.py situation.
    """
    write(
        tmp_path,
        "env.py",
        """
import subprocess

def _grade(completion):
    subprocess.run(["python", "verifier.py", completion], timeout=30)
    return 1.0

def build():
    return vf.Rubric(funcs=[_grade])
""",
    )
    write(
        tmp_path,
        "verifier.py",
        r"""
import re

def check(answer):
    m = re.search(r"(\d+)", answer)
    return 1.0 if m else 0.0
""",
    )

    result = analyze(tmp_path)
    escapes = result["subprocess_escapes"]
    assert len(escapes) == 1
    assert escapes[0]["script"] == "verifier.py"
    assert escapes[0]["resolved"] is True
    assert escapes[0]["module_loaded"] == "verifier"

    # The actual point: the defect-pattern scan now reaches verifier.py.
    report = audit(tmp_path)
    assert "regex_answer_extraction" in report["signature_classes"]
    hit_modules = {h["module"] for h in report["signatures"]["regex_answer_extraction"]}
    assert "verifier" in hit_modules


def test_subprocess_escape_resolves_script_relative_to_environment_root(tmp_path: Path) -> None:
    """research-debugging's actual layout: the script sits under assets/hidden/,
    not next to the caller module."""
    write(
        tmp_path,
        "task.py",
        """
import subprocess

def _grade(completion):
    subprocess.run(["python", "assets/hidden/verifier.py", completion])
    return 1.0

def build():
    return vf.Rubric(funcs=[_grade])
""",
    )
    write(
        tmp_path,
        "assets/hidden/verifier.py",
        """
def check(answer):
    return 1.0 if answer == "expected" else 0.0
""",
    )

    result = analyze(tmp_path)
    escape = result["subprocess_escapes"][0]
    assert escape["resolved"] is True
    assert "assets" in escape["module_loaded"]
    assert "assets.hidden.verifier:check" in result["reachable"]


def test_subprocess_escape_with_a_dynamic_path_stays_unresolved(tmp_path: Path) -> None:
    """A script path built from a variable is not guessed at."""
    write(
        tmp_path,
        "env.py",
        """
import subprocess

def _grade(completion, script_name):
    subprocess.run(["python", script_name, completion])
    return 1.0

def build():
    return vf.Rubric(funcs=[_grade])
""",
    )
    result = analyze(tmp_path)
    escape = result["subprocess_escapes"][0]
    assert escape["script"] is None
    assert escape["resolved"] is False


def test_subprocess_escape_resolves_a_path_join_of_literal_parts(tmp_path: Path) -> None:
    """`Path("a") / "b"` folds to a constant string when every part is a
    literal -- as opposed to `Path(__file__).parent / "b"`, which depends on
    where the file happens to live and is deliberately left unresolved rather
    than approximated."""
    write(
        tmp_path,
        "env.py",
        """
import subprocess
from pathlib import Path

def _grade(completion):
    subprocess.run(["python", str(Path("assets/hidden") / "verifier.py"), completion])
    return 1.0

def build():
    return vf.Rubric(funcs=[_grade])
""",
    )
    write(tmp_path, "assets/hidden/verifier.py", "def check(x):\n    return 1.0\n")

    result = analyze(tmp_path)
    escape = result["subprocess_escapes"][0]
    assert escape["resolved"] is True


def test_subprocess_escape_leaves_file_relative_paths_unresolved(tmp_path: Path) -> None:
    """`Path(__file__).parent / "x.py"` is not guessed at: resolving it
    correctly would require knowing the caller's own location, which is a
    step beyond constant-folding the expression itself."""
    write(
        tmp_path,
        "env.py",
        """
import subprocess
from pathlib import Path

def _grade(completion):
    script = str(Path(__file__).parent / "verifier.py")
    subprocess.run(["python", script, completion])
    return 1.0

def build():
    return vf.Rubric(funcs=[_grade])
""",
    )
    result = analyze(tmp_path)
    escape = result["subprocess_escapes"][0]
    assert escape["resolved"] is False
