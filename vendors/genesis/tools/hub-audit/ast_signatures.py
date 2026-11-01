#!/usr/bin/env python3
"""
Defect signatures detected structurally, scoped to the reward call graph.

Two changes from the regex survey in HUB-001, and both were forced by its
failures rather than chosen:

  1. **Scope.** Only functions reachable from a reward root are examined.
     HUB-001's `stdout_trusted` and `llm_judge` classes were 100% false
     positives because they matched a CLI's help string, terminal
     line-buffering, a simulated user and an agent-facing tool -- none of them
     grading code.

  2. **Structure.** Detection walks the AST rather than lines. HUB-001's
     `missing_timeouts` flagged a `subprocess.run(...)` that *does* pass
     `timeout=900`, purely because the keyword sat on a later line; 4 of its 10
     hits were multi-line calls the pattern could not see past. A keyword
     lookup on the Call node cannot make that mistake.

`startswith`/`endswith` matching is gone entirely. It produced 288 of 477
`substring_match_grading` hits and identified nothing.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from reward_graph import RewardGraph, analyze

SUBPROCESS_CALLS = {"run", "call", "check_call", "check_output", "Popen"}
LABEL_KEYS = {"answer", "label", "gold", "target", "solution", "expected", "truth"}
TOLERANCE_FNS = {"isclose", "allclose", "approx"}


@dataclass
class Signature:
    defect_class: str
    module: str
    function: str
    line: int
    detail: str
    snippet: str


def _name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parts, cur = [], node
        while isinstance(cur, ast.Attribute):
            parts.append(cur.attr)
            cur = cur.value
        if isinstance(cur, ast.Name):
            parts.append(cur.id)
            return ".".join(reversed(parts))
        return ".".join(reversed(parts))
    return ""


def _src_line(src_lines: list[str], lineno: int) -> str:
    return src_lines[lineno - 1].strip()[:150] if 0 < lineno <= len(src_lines) else ""


def scan_function(
    module: str, qualname: str, node: ast.AST, src_lines: list[str]
) -> list[Signature]:
    out: list[Signature] = []

    def add(cls: str, ln: int, detail: str) -> None:
        out.append(Signature(cls, module, qualname, ln, detail, _src_line(src_lines, ln)))

    for n in ast.walk(node):
        # ── subprocess without a wall-clock bound (structural) ─────────────
        if isinstance(n, ast.Call):
            fname = _name(n.func)
            tail = fname.split(".")[-1]
            if tail in SUBPROCESS_CALLS and ("subprocess" in fname or tail == "Popen"):
                kwargs = {kw.arg for kw in n.keywords if kw.arg}
                if "timeout" not in kwargs:
                    # Popen never takes timeout at construction; the bound would
                    # be on a later .wait()/.communicate(). Report it as
                    # unbounded-at-call rather than as a confirmed defect.
                    kind = "subprocess_popen_unbounded_at_call" if tail == "Popen" else "missing_timeout"
                    add(kind, n.lineno, f"{fname}() with no timeout= keyword")

            # ── float tolerance in a grading path ──────────────────────────
            if tail in TOLERANCE_FNS:
                kwargs = {kw.arg: kw.value for kw in n.keywords if kw.arg}
                bits = []
                for k in ("rel_tol", "abs_tol", "rtol", "atol"):
                    if k in kwargs:
                        try:
                            bits.append(f"{k}={ast.literal_eval(kwargs[k])}")
                        except (ValueError, TypeError):
                            bits.append(f"{k}=<expr>")
                add("loose_numeric_tolerance", n.lineno,
                    f"{fname}({', '.join(bits) if bits else 'defaults'})")

            # ── regex answer extraction ────────────────────────────────────
            if fname.startswith("re.") and tail in {"findall", "search", "match", "finditer", "fullmatch"}:
                pat = ""
                if n.args:
                    try:
                        pat = str(ast.literal_eval(n.args[0]))[:60]
                    except (ValueError, TypeError):
                        pat = "<dynamic>"
                add("regex_answer_extraction", n.lineno, f"re.{tail}(r'{pat}')")

        # ── abs(a - b) < tol ───────────────────────────────────────────────
        if isinstance(n, ast.Compare) and len(n.ops) == 1 and isinstance(n.ops[0], (ast.Lt, ast.LtE)):
            left = n.left
            if isinstance(left, ast.Call) and _name(left.func) == "abs" and left.args:
                inner = left.args[0]
                if isinstance(inner, ast.BinOp) and isinstance(inner.op, ast.Sub):
                    try:
                        tol = ast.literal_eval(n.comparators[0])
                        add("loose_numeric_tolerance", n.lineno, f"abs(a-b) < {tol}")
                    except (ValueError, TypeError):
                        add("loose_numeric_tolerance", n.lineno, "abs(a-b) < <expr>")

        # ── comparison against a stored label ──────────────────────────────
        if isinstance(n, ast.Compare) and any(isinstance(o, ast.Eq) for o in n.ops):
            for side in [n.left, *n.comparators]:
                if isinstance(side, ast.Subscript):
                    try:
                        key = ast.literal_eval(side.slice)
                    except (ValueError, TypeError):
                        continue
                    if isinstance(key, str) and key.lower() in LABEL_KEYS:
                        add("stored_label_compared", n.lineno,
                            f"compares against [{key!r}] rather than recomputing")

        # ── containment deciding correctness ───────────────────────────────
        # Only when it is the thing being returned, which is what makes it
        # grading rather than incidental string handling.
        #
        # `x in y` is substring matching when y is text and set membership when
        # y is a collection, and the two are indistinguishable from a bare Name
        # without type inference. research-debugging returns
        # `0.0 if "diagnosis" in failed else 1.0` where `failed` is a set --
        # entirely legitimate, and flagging it as a substring defect would
        # repeat HUB-001's mistake in a new place. So the ambiguous case is
        # reported at low confidence and kept separate from the case where the
        # right operand is provably text.
        if isinstance(n, ast.Return) and n.value is not None:
            for sub in ast.walk(n.value):
                if not (isinstance(sub, ast.Compare) and any(isinstance(o, ast.In) for o in sub.ops)):
                    continue
                rhs = sub.comparators[0] if sub.comparators else None
                provably_text = isinstance(rhs, (ast.Constant, ast.JoinedStr)) and (
                    not isinstance(rhs, ast.Constant) or isinstance(rhs.value, str)
                )
                if isinstance(rhs, ast.Call) and _name(rhs.func).endswith((".lower", ".upper", ".strip")):
                    provably_text = True
                if provably_text:
                    add("substring_decides_reward", sub.lineno,
                        "`in` against provably-text operand in a returned expression")
                else:
                    add("containment_decides_reward_UNTYPED", sub.lineno,
                        "`in` in a returned expression; operand type unknown "
                        "(substring match and set membership are indistinguishable here)")
                break

    return out


def audit(root: Path) -> dict:
    result = analyze(root)
    graph: RewardGraph = result["graph"]
    roots = [f for f in graph.funcs.values() if f.is_reward_root]
    reach = graph.reachable(roots)

    src_cache: dict[str, list[str]] = {}
    sigs: list[Signature] = []
    for (mod, qual), fd in sorted(reach.items()):
        info = graph.modules.get(mod)
        if not info:
            continue
        if mod not in src_cache:
            src_cache[mod] = info.path.read_text(errors="replace").splitlines()
        sigs.extend(scan_function(mod, qual, fd.node, src_cache[mod]))

    by_class: dict[str, list[dict]] = {}
    for s in sigs:
        by_class.setdefault(s.defect_class, []).append({
            "module": s.module, "function": s.function, "line": s.line,
            "detail": s.detail, "snippet": s.snippet,
        })

    return {
        "modules": result["modules"],
        "functions_total": result["functions_total"],
        "reward_roots": result["reward_roots"],
        "reachable_count": result["reachable_count"],
        "reachable": result["reachable"],
        "scope_reduction": (
            1 - result["reachable_count"] / result["functions_total"]
            if result["functions_total"] else 0.0
        ),
        "unresolved": result["unresolved"],
        "subprocess_escapes": result["subprocess_escapes"],
        "signatures": by_class,
        "signature_classes": sorted(by_class),
    }


if __name__ == "__main__":
    import json
    import sys

    print(json.dumps(audit(Path(sys.argv[1])), indent=2))
