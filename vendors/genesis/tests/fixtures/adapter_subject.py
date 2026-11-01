"""Test fixture: Python subject implementing the adapter protocol."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "adapters", "python"))

from genesis_adapter import run_subject  # noqa: E402


def solve(task):
    return {"echo": task.get("input")}


if __name__ == "__main__":
    run_subject(solve)
