"""Keyword sentiment classifier — a Genesis subject in Python.

Implements the adapter protocol via the genesis_adapter helper package.
Run from the repository root so the helper is importable:

    python ./examples/python-classifier/subject.py <task.json>
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "adapters", "python"))

from genesis_adapter import run_subject  # noqa: E402

POS = {"love", "great", "excellent", "fantastic", "recommend", "value", "fast"}
NEG = {"terrible", "broke", "worst", "hate", "poor", "awful", "disappointing", "bad"}


def classify(task):
    tokens = {t for t in str(task.get("input", "")).lower().replace(",", " ").split() if t}
    pos = len(POS & tokens)
    neg = len(NEG & tokens)
    label = "positive" if pos >= neg else "negative"
    return {"label": label, "score": 0.9 if label == "positive" else 0.1}


if __name__ == "__main__":
    run_subject(classify)
