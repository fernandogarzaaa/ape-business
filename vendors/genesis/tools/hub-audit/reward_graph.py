#!/usr/bin/env python3
"""
Locate reward functions structurally and compute what they can reach.

This is the blocker named in HUB-001 §6. Static signature scanning over a whole
environment package cannot measure grading defects, because an environment
contains a task generator, a simulated user, agent-facing tools, a CLI, tests
and vendored dependencies -- and only the reward function can hold a *reward*
defect. Grep cannot tell those apart. An AST call graph rooted at the reward
functions can.

Three registration patterns, all found in real hub environments rather than
assumed:

  1. classic ``verifiers``     rubric = vf.Rubric(funcs=[my_reward], weights=[1.0])
  2. ``verifiers.v1``          class T(vf.Task): @vf.reward(weight=0.6)
                                                async def answer_correct(...)
  3. cross-process             the reward path shells out to a grader script
                               (e.g. assets/hidden/verifier.py) -- a Python call
                               graph cannot follow this, so it is detected and
                               reported rather than silently missed.

Output is the set of (module, qualname) reachable from a reward root, plus the
unresolved edges, so a caller can see how much of the graph is actually known.
"""
from __future__ import annotations

import ast
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Directories that never contain grading logic. Deliberately short: excluding
# too much is how you miss a grader. `assets` is NOT excluded -- research-
# debugging keeps its real verifier under assets/hidden/.
SKIP_DIR_NAMES = {"__pycache__", ".venv", ".git", "node_modules", ".mypy_cache", ".pytest_cache"}
TEST_DIR_NAMES = {"tests", "test"}


def is_test_path(rel: Path) -> bool:
    return any(p in TEST_DIR_NAMES for p in rel.parts) or rel.name.startswith("test_")


@dataclass
class FuncDef:
    module: str
    qualname: str
    node: ast.AST
    lineno: int
    is_reward_root: bool = False
    root_reason: str = ""


@dataclass
class ModuleInfo:
    name: str
    path: Path
    tree: ast.Module
    # local name -> (module, original_name) for `from X import y`
    imports: dict[str, tuple[str, str]] = field(default_factory=dict)
    # local alias -> module for `import X as y`
    module_aliases: dict[str, str] = field(default_factory=dict)


class RewardGraph:
    def __init__(self, root: Path, package_hint: str | None = None):
        self.root = root
        self.package_hint = package_hint
        self.modules: dict[str, ModuleInfo] = {}
        self.funcs: dict[tuple[str, str], FuncDef] = {}
        self.unresolved: list[dict] = []
        self.subprocess_escapes: list[dict] = []

    # ── loading ────────────────────────────────────────────────────────────

    def load(self) -> None:
        for path in sorted(self.root.rglob("*.py")):
            rel = path.relative_to(self.root)
            if any(p in SKIP_DIR_NAMES for p in rel.parts):
                continue
            if is_test_path(rel):
                continue
            try:
                src = path.read_text(errors="replace")
                tree = ast.parse(src)
            except (SyntaxError, OSError, ValueError):
                continue
            modname = ".".join(rel.with_suffix("").parts)
            if modname.endswith(".__init__"):
                modname = modname[: -len(".__init__")]
            info = ModuleInfo(name=modname, path=path, tree=tree)
            self._collect_imports(info)
            self.modules[modname] = info
            self._collect_funcs(info)

    def _collect_imports(self, info: ModuleInfo) -> None:
        for node in ast.walk(info.tree):
            if isinstance(node, ast.ImportFrom):
                # Relative imports: level=1 means same package as this module.
                base = node.module or ""
                if node.level:
                    parts = info.name.split(".")
                    prefix = parts[: max(0, len(parts) - node.level + 1)]
                    base = ".".join([*prefix, base]) if base else ".".join(prefix)
                for alias in node.names:
                    local = alias.asname or alias.name
                    info.imports[local] = (base, alias.name)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    local = alias.asname or alias.name.split(".")[0]
                    info.module_aliases[local] = alias.name

    def _collect_funcs(self, info: ModuleInfo) -> None:
        def visit(node: ast.AST, prefix: str) -> None:
            for child in ast.iter_child_nodes(node):
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    qual = f"{prefix}{child.name}"
                    self.funcs[(info.name, qual)] = FuncDef(
                        module=info.name, qualname=qual, node=child, lineno=child.lineno
                    )
                    visit(child, f"{qual}.")
                elif isinstance(child, ast.ClassDef):
                    visit(child, f"{prefix}{child.name}.")

        visit(info.tree, "")

    # ── finding reward roots ───────────────────────────────────────────────

    def find_roots(self) -> list[FuncDef]:
        roots: list[FuncDef] = []
        for info in self.modules.values():
            roots.extend(self._roots_from_rubric(info))
            roots.extend(self._roots_from_decorator(info))
            roots.extend(self._roots_from_imperative(info))
        # de-dupe, marking each
        seen: set[tuple[str, str]] = set()
        out: list[FuncDef] = []
        for fd in roots:
            key = (fd.module, fd.qualname)
            if key in seen:
                continue
            seen.add(key)
            fd.is_reward_root = True
            out.append(fd)
        return out

    def _roots_from_rubric(self, info: ModuleInfo) -> list[FuncDef]:
        """Pattern 1: Rubric(funcs=[...]) / reward_funcs=[...]."""
        found: list[FuncDef] = []
        for node in ast.walk(info.tree):
            if not isinstance(node, ast.Call):
                continue
            name = self._call_name(node.func)
            if not name or not name.split(".")[-1].endswith("Rubric"):
                continue
            for kw in node.keywords:
                if kw.arg not in {"funcs", "reward_funcs"}:
                    continue
                for elt in self._iter_list(info, kw.value):
                    ref = self._call_name(elt)
                    if not ref:
                        continue
                    fd = self._resolve(info, ref)
                    if fd:
                        fd.root_reason = f"Rubric(funcs=[...]) at {info.name}:{node.lineno}"
                        found.append(fd)
                    else:
                        self.unresolved.append(
                            {"kind": "rubric_func", "module": info.name,
                             "line": node.lineno, "name": ref}
                        )
        return found

    def _roots_from_decorator(self, info: ModuleInfo) -> list[FuncDef]:
        """Pattern 2: @vf.reward / @reward decorated methods (verifiers.v1)."""
        found: list[FuncDef] = []
        for (mod, qual), fd in self.funcs.items():
            if mod != info.name:
                continue
            node = fd.node
            for dec in getattr(node, "decorator_list", []):
                target = dec.func if isinstance(dec, ast.Call) else dec
                dname = self._call_name(target) or ""
                if dname.split(".")[-1] == "reward":
                    fd.root_reason = f"@{dname} at {info.name}:{dec.lineno}"
                    found.append(fd)
                    break
        return found

    def _roots_from_imperative(self, info: ModuleInfo) -> list[FuncDef]:
        """Pattern 4: reward emitted imperatively rather than declared.

        `trace.record_reward("wasserstein_reward", outcome.reward)` inside a
        step function -- found in punnettsquare9331/mcmcenv, which the
        declarative patterns miss entirely. The enclosing function is the root:
        it is the code that decides the number.
        """
        found: list[FuncDef] = []
        for (mod, qual), fd in self.funcs.items():
            if mod != info.name:
                continue
            for call in ast.walk(fd.node):
                if not isinstance(call, ast.Call):
                    continue
                tail = (self._call_name(call.func) or "").split(".")[-1]
                if tail in {"record_reward", "set_reward", "add_reward"}:
                    fd.root_reason = f"{tail}() at {info.name}:{call.lineno}"
                    found.append(fd)
                    break
        return found

    # ── call graph ─────────────────────────────────────────────────────────

    def reachable(self, roots: list[FuncDef]) -> dict[tuple[str, str], FuncDef]:
        # Reset per traversal: callers may walk the graph more than once, and
        # escapes are a property of the walk, not an accumulator.
        self.subprocess_escapes = []
        seen: dict[tuple[str, str], FuncDef] = {}
        frontier = list(roots)
        while frontier:
            fd = frontier.pop()
            key = (fd.module, fd.qualname)
            if key in seen:
                continue
            seen[key] = fd
            info = self.modules.get(fd.module)
            if not info:
                continue
            for call in ast.walk(fd.node):
                if not isinstance(call, ast.Call):
                    continue
                # A resolved escape hands back the invoked script's functions,
                # which join the walk exactly like an ordinary call target --
                # this is what lets ast_signatures.py's scan reach a grader
                # that lives in a subprocess-invoked script (e.g. research-
                # debugging's assets/hidden/verifier.py) instead of stopping
                # at the wrapper that shells out to it.
                frontier.extend(self._note_subprocess_escape(info, fd, call))
                ref = self._call_name(call.func)
                if not ref:
                    continue
                nxt = self._resolve(info, ref, enclosing=fd)
                if nxt:
                    frontier.append(nxt)
        return seen

    SUBPROCESS_TAILS = {"run", "call", "check_call", "check_output", "Popen"}

    def _note_subprocess_escape(self, info: ModuleInfo, fd: FuncDef, call: ast.Call) -> list[FuncDef]:
        """A reward path that shells out leaves the Python call graph.

        Record it rather than silently treating the grader as absent, and --
        when the invoked script's path is a resolvable constant -- load that
        script as an additional module and hand back its functions so the
        walk continues into it instead of stopping at the wrapper.
        """
        name = self._call_name(call.func) or ""
        tail = name.split(".")[-1]
        if not (name.startswith("subprocess.") or tail in self.SUBPROCESS_TAILS):
            return []

        script = self._extract_script_path(call)
        escape = {
            "module": info.name, "function": fd.qualname, "line": call.lineno,
            "call": name, "script": script, "resolved": False,
        }
        self.subprocess_escapes.append(escape)
        if not script:
            return []

        target = self._load_subprocess_module(info, script)
        if not target:
            return []

        escape["resolved"] = True
        escape["module_loaded"] = target.name
        return [f for (m, _q), f in self.funcs.items() if m == target.name]

    def _extract_script_path(self, call: ast.Call) -> str | None:
        """Pull a `*.py` path out of a subprocess call's argument list.

        Only constant or near-constant expressions resolve -- a literal
        string, an f-string/`Path(...)`/string join built entirely from
        literal parts. Anything more dynamic (a variable, a function result)
        is left unresolved rather than guessed at.
        """
        candidates: list[ast.AST] = []
        if call.args:
            first = call.args[0]
            if isinstance(first, (ast.List, ast.Tuple)):
                candidates.extend(first.elts)
            else:
                candidates.append(first)
        for kw in call.keywords:
            if kw.arg == "args" and isinstance(kw.value, (ast.List, ast.Tuple)):
                candidates.extend(kw.value.elts)

        for node in candidates:
            s = self._const_str(node)
            if s and s.endswith(".py"):
                return s
        return None

    @staticmethod
    def _const_str(node: ast.AST) -> str | None:
        """Best-effort constant-folding of a string-ish expression.

        Handles a plain string literal, an f-string whose parts are all
        literal, `a + b` where both sides fold, and `Path(x) / "y"` joins --
        deliberately not a general evaluator, just enough to see through the
        common ways a script path gets spelled with no real variable in it.
        """
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.JoinedStr):
            parts: list[str] = []
            for value in node.values:
                part = RewardGraph._const_str(value)
                if part is None:
                    return None
                parts.append(part)
            return "".join(parts)
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Div)):
            left = RewardGraph._const_str(node.left)
            right = RewardGraph._const_str(node.right)
            if left is None or right is None:
                return None
            if isinstance(node.op, ast.Div):
                return f"{left.rstrip('/')}/{right.lstrip('/')}"
            return left + right
        if isinstance(node, ast.Call):
            fname = RewardGraph._call_name(node.func) or ""
            tail = fname.split(".")[-1]
            # `Path("a")` folds to its first argument; `str(x)` is transparent
            # to the string it wraps -- both show up around a script path
            # passed to subprocess.run, which always wants a str/PathLike.
            if tail in {"Path", "str"} and node.args:
                return RewardGraph._const_str(node.args[0])
        return None

    def _load_subprocess_module(self, info: ModuleInfo, script: str) -> ModuleInfo | None:
        """Resolve `script` to a file and load it into `self.modules`.

        Tried relative to the calling module's own directory first (the
        common case: a grader ships its verifier script alongside itself),
        then relative to the environment's checkout root -- matching how
        `run_survey.py` lays out the tree it hands to `RewardGraph`.
        """
        root = self.root.resolve()
        for base in (info.path.parent, self.root):
            candidate = (base / script).resolve()
            try:
                rel = candidate.relative_to(root)
            except ValueError:
                continue

            modname = ".".join(rel.with_suffix("").parts)
            if modname in self.modules:
                return self.modules[modname]
            if not candidate.is_file():
                continue

            try:
                tree = ast.parse(candidate.read_text(errors="replace"))
            except (SyntaxError, OSError, ValueError):
                continue

            new_info = ModuleInfo(name=modname, path=candidate, tree=tree)
            self._collect_imports(new_info)
            self.modules[modname] = new_info
            self._collect_funcs(new_info)
            return new_info
        return None

    # ── name resolution ────────────────────────────────────────────────────

    def _resolve(self, info: ModuleInfo, ref: str, enclosing: FuncDef | None = None) -> FuncDef | None:
        parts = ref.split(".")
        head, tail = parts[0], parts[-1]

        # self.method(...) inside a class -> same class
        if head == "self" and enclosing and "." in enclosing.qualname:
            cls = enclosing.qualname.rsplit(".", 1)[0]
            fd = self.funcs.get((info.name, f"{cls}.{tail}"))
            if fd:
                return fd

        # plain local function
        fd = self.funcs.get((info.name, ref)) or self.funcs.get((info.name, tail))
        if fd:
            return fd

        # imported name: `from .core import verify_determinant`
        if head in info.imports:
            mod, orig = info.imports[head]
            for cand in (orig, tail):
                fd = self.funcs.get((mod, cand))
                if fd:
                    return fd
            # module imported wholesale then attribute-accessed
            fd = self.funcs.get((mod, tail))
            if fd:
                return fd

        # `import pkg.mod as m; m.func()`
        if head in info.module_aliases:
            fd = self.funcs.get((info.module_aliases[head], tail))
            if fd:
                return fd

        # last resort: unique match on the bare name anywhere in the package
        matches = [f for (m, q), f in self.funcs.items() if q == tail or q.endswith(f".{tail}")]
        if len(matches) == 1:
            return matches[0]
        return None

    # ── small helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _call_name(node: ast.AST) -> str | None:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            parts = []
            cur: ast.AST = node
            while isinstance(cur, ast.Attribute):
                parts.append(cur.attr)
                cur = cur.value
            if isinstance(cur, ast.Name):
                parts.append(cur.id)
                return ".".join(reversed(parts))
        return None

    def _iter_list(self, info: ModuleInfo, node: ast.AST):
        """Yield the elements of a `funcs=`-style keyword value.

        Handles the inline-literal case directly (`funcs=[a, b]`) and, since
        HUB-002, the variable-bound case too: `funcs = [a, b]` assigned
        earlier in the same module, then passed as `Rubric(funcs=funcs)` --
        the pattern solar-sight/solar-eval's env.py:664 actually uses, which
        made it show up as "unresolved" in the hub survey. Anything else
        (a call, an imported name, a comprehension) is yielded as-is so the
        caller's normal resolve-or-report-unresolved path still applies.
        """
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            yield from node.elts
            return
        if isinstance(node, ast.Name):
            bound = self._resolve_list_assignment(info, node.id)
            if bound is not None:
                yield from bound
                return
        yield node

    @staticmethod
    def _resolve_list_assignment(info: ModuleInfo, name: str) -> list[ast.AST] | None:
        """Find `name = [...]` (list/tuple/set literal) elsewhere in the module.

        Same-module only -- this is data-flow *within* a file, not a general
        import-following resolver. The last matching assignment wins, mirroring
        ordinary variable rebinding.
        """
        found: list[ast.AST] | None = None
        for node in ast.walk(info.tree):
            if not isinstance(node, ast.Assign):
                continue
            if not isinstance(node.value, (ast.List, ast.Tuple, ast.Set)):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == name:
                    found = node.value.elts
        return found


def analyze(root: Path) -> dict:
    g = RewardGraph(root)
    g.load()
    roots = g.find_roots()
    reach = g.reachable(roots)
    return {
        "modules": len(g.modules),
        "functions_total": len(g.funcs),
        "reward_roots": [
            {"module": r.module, "function": r.qualname, "line": r.lineno, "why": r.root_reason}
            for r in sorted(roots, key=lambda f: (f.module, f.qualname))
        ],
        "reachable": sorted({f"{m}:{q}" for (m, q) in reach}),
        "reachable_count": len(reach),
        "unresolved": g.unresolved,
        "subprocess_escapes": g.subprocess_escapes,
        "graph": g,
    }


if __name__ == "__main__":
    import json

    result = analyze(Path(sys.argv[1]))
    result.pop("graph")
    print(json.dumps(result, indent=2))
