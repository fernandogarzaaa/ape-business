#!/usr/bin/env python3
"""
Confirm a static reward-function target dynamically.

HUB-002 produced 47 static targets and stopped there deliberately: "47
targets, not 47 defects." Confirming one means constructing a completion that
satisfies the flagged pattern without doing the task, and checking whether
the grader still pays out. This is that check, generalized.

It does not assume `verifiers`/`datasets`/any of an environment's real
dependencies are installed, because a reward function is almost always a
pure function of (completion, answer) with no need for the rest of the
package. The function is located by name via AST; its exact source segment,
plus the transitive closure of same-file module-level helper functions and
constants it references, is exec'd in an isolated namespace -- the
environment package itself is never imported, so this works even when its
dependencies are absent.

See docs/assurance/findings/HUB-003-build-optimization-reward-gaming.md and
HUB-004-carcassonne-placement-reward-defects.md for confirmed results.
"""
from __future__ import annotations

import argparse
import ast
import asyncio
import inspect
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Callable, Optional


class FunctionNotFound(Exception):
    pass


def find_function_source(env_dir: Path, func_name: str) -> tuple[Path, str]:
    """Search every .py file under env_dir for a def/async def named
    func_name (top-level or nested in a class) and return (file, its exact
    source segment) for the first match. Decorators are not included -- this
    extracts the raw callable, not whatever a registration decorator wraps
    it into, which is what scoring it standalone requires."""
    for path in sorted(env_dir.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        try:
            source = path.read_text()
            tree = ast.parse(source, filename=str(path))
        except (SyntaxError, UnicodeDecodeError):
            continue
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
                segment = ast.get_source_segment(source, node)
                if segment is not None:
                    return path, segment
    raise FunctionNotFound(f'no def/async def "{func_name}" found under {env_dir}')


def _referenced_names(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}


def _module_level_definitions(tree: ast.Module) -> dict[str, ast.AST]:
    """Map name -> defining node for every top-level function and simple
    constant assignment in a module. Deliberately excludes classes and
    anything not directly `exec`-able in isolation -- a reward function
    that depends on one of those still fails with a NameError, same as
    before this existed."""
    out: dict[str, ast.AST] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out[node.name] = node
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    out[target.id] = node
    return out


def _resolve_dependencies(tree: ast.Module, source: str, entry: ast.AST) -> list[str]:
    """A reward function calling a same-file helper (`can_place`,
    `get_piece_cells`, a module-level `PIECES` dict, ...) is common -- more
    common than the single-function extraction this tool started with could
    handle. This walks the entry node's referenced names, resolves any that
    match a module-level definition, and recurses into each one's own
    references, so the exec namespace carries the whole reachable same-file
    closure rather than just the one named function."""
    definitions = _module_level_definitions(tree)
    resolved: dict[str, str] = {}
    queue = list(_referenced_names(entry))
    seen_names = set(queue)

    while queue:
        name = queue.pop()
        if name in resolved or name not in definitions:
            continue
        dep_node = definitions[name]
        segment = ast.get_source_segment(source, dep_node)
        if segment is None:
            continue
        resolved[name] = segment
        for ref in _referenced_names(dep_node):
            if ref not in seen_names:
                seen_names.add(ref)
                queue.append(ref)

    return list(resolved.values())


def load_reward_fn(env_dir: Path, func_name: str) -> Callable[..., Any]:
    """Load a named reward function without importing the environment
    package. The namespace carries the stdlib modules reward functions
    commonly reach for at call time (regex extraction, JSON-encoded answers,
    numeric tolerance), plus the transitive closure of same-file, module-level
    helper functions and constants the target actually references (see
    `_resolve_dependencies`) -- not an import of the environment package
    itself, which this deliberately never does. If the function still depends
    on a name neither of those provides (an import, a class, a helper defined
    inside another function), that fails loudly as a NameError rather than
    silently."""
    path, source_segment = find_function_source(env_dir, func_name)
    module_source = path.read_text()
    tree = ast.parse(module_source, filename=str(path))
    entry = next(
        n for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == func_name
    )

    namespace: dict[str, Any] = {"re": re, "json": json, "math": math, "Any": Any, "Optional": Optional}
    for dep_source in _resolve_dependencies(tree, module_source, entry):
        exec(compile(dep_source, f"<{func_name}-dependency>", "exec"), namespace)
    exec(compile(source_segment, f"<{func_name}>", "exec"), namespace)
    return namespace[func_name]


async def _call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    result = fn(*args, **kwargs)
    if inspect.isawaitable(result):
        result = await result
    return result


def score_completions(fn: Callable[..., Any], answer: str, completions: dict[str, str]) -> dict[str, float]:
    """Run one reward function against {label: completion text}, wrapping
    each as the one-turn chat transcript `verifiers`-style rewards expect."""

    async def run() -> dict[str, float]:
        out: dict[str, float] = {}
        for label, text in completions.items():
            transcript = [{"role": "assistant", "content": text}]
            out[label] = await _call(fn, transcript, answer)
        return out

    return asyncio.run(run())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("env_dir", type=Path, help="a directory from `prime env pull`")
    parser.add_argument("func_name", help="the reward function's name, e.g. build_optimization_reward")
    parser.add_argument("answer", help="the ground-truth `answer` string for one dataset row")
    parser.add_argument("completions", type=Path, help="a JSON file of {label: completion text} to score")
    args = parser.parse_args()

    fn = load_reward_fn(args.env_dir, args.func_name)
    completions = json.loads(args.completions.read_text())
    scores = score_completions(fn, args.answer, completions)

    width = max(len(label) for label in scores)
    for label, score in scores.items():
        print(f"{score:.4f}  {label:<{width}}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
