"""Genesis adapter protocol for Python (stdlib only, no dependencies).

Subjects::

    from genesis_adapter import run_subject

    def solve(task):  # task: dict with id/input/reference/...
        return str(int(task["input"]) * 2)

    if __name__ == "__main__":
        run_subject(solve)

External evaluators::

    from genesis_adapter import run_evaluator

    def judge(task, output):  # output: parsed JSON or raw string
        return {"passed": output == task["reference"], "score": 1.0}

    if __name__ == "__main__":
        run_evaluator(judge)
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Callable, Union

__all__ = [
    "load_task",
    "load_output",
    "format_output",
    "format_verdict",
    "run_subject",
    "run_evaluator",
]

Verdict = Union[bool, int, float, dict]


def _first_arg(env_name: str, position: int) -> str | None:
    if len(sys.argv) > position and sys.argv[position]:
        return sys.argv[position]
    return os.environ.get(env_name)


def load_task(path: str | None = None) -> dict:
    """Load the task JSON from argv[1] or GENESIS_TASK_FILE."""
    resolved = path or _first_arg("GENESIS_TASK_FILE", 1)
    if not resolved:
        raise SystemExit("genesis_adapter: expected a task file as argv[1] or GENESIS_TASK_FILE")
    with open(resolved, encoding="utf-8") as fh:
        task = json.load(fh)
    if not isinstance(task, dict):
        raise SystemExit("genesis_adapter: task file must hold a JSON object")
    return task


def load_output(path: str | None = None) -> tuple[Any, str]:
    """Return (parsed_or_raw_output, raw_text) from argv[2] or GENESIS_OUTPUT_FILE."""
    resolved = path or _first_arg("GENESIS_OUTPUT_FILE", 2)
    if not resolved:
        raise SystemExit("genesis_adapter: expected an output file as argv[2] or GENESIS_OUTPUT_FILE")
    with open(resolved, encoding="utf-8") as fh:
        raw = fh.read()
    try:
        return json.loads(raw), raw
    except (json.JSONDecodeError, ValueError):
        return raw, raw


def format_output(value: Any) -> str:
    """Subject envelope: strings verbatim, everything else as JSON."""
    if isinstance(value, str):
        return value
    return json.dumps(value)


def format_verdict(value: Verdict) -> str:
    """Evaluator envelope: bool/number/dict → JSON with passed/score."""
    if isinstance(value, bool):
        return json.dumps({"passed": value})
    if isinstance(value, (int, float)):
        if not _finite(value):
            raise ValueError(f"evaluator score must be finite, got {value!r}")
        return json.dumps({"score": value})
    if isinstance(value, dict):
        if "passed" not in value and "score" not in value:
            raise ValueError("evaluator dict must contain 'passed' and/or 'score'")
        return json.dumps(value)
    raise ValueError(f"evaluator must return bool, number, or dict — got {type(value).__name__}")


def _finite(value: Union[int, float]) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))


def run_subject(fn: Callable[[dict], Any]) -> None:
    """Run a subject function: load task → fn(task) → stdout. Exit 1 on error."""
    try:
        task = load_task()
        result = fn(task)
        out = format_output(result)
        sys.stdout.write(out)
        if not out.endswith("\n"):
            sys.stdout.write("\n")
    except BrokenPipeError:
        sys.exit(1)
    except Exception as error:  # subject errors are recorded, never verdicts
        sys.stderr.write(f"genesis_adapter subject error: {error}\n")
        sys.exit(1)


def run_evaluator(fn: Callable[[dict, Any], Verdict]) -> None:
    """Run an evaluator function: load task+output → fn → JSON envelope on stdout."""
    try:
        task = load_task()
        output, _raw = load_output()
        sys.stdout.write(format_verdict(fn(task, output)))
        sys.stdout.write("\n")
    except BrokenPipeError:
        sys.exit(1)
    except Exception as error:
        # Emit a diagnosable envelope AND fail: without passed/score Genesis
        # records the trial as unjudged rather than inventing a verdict.
        sys.stdout.write(json.dumps({"error": str(error)}) + "\n")
        sys.stderr.write(f"genesis_adapter evaluator error: {error}\n")
        sys.exit(1)
