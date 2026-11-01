"""Test fixture: Python evaluator implementing the adapter protocol."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "adapters", "python"))

from genesis_adapter import run_evaluator  # noqa: E402


def judge(task, output):
    actual = output.get("echo") if isinstance(output, dict) else output
    return {"passed": actual == task.get("input")}


if __name__ == "__main__":
    run_evaluator(judge)
