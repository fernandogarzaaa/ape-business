#!/usr/bin/env python3
"""
Static reconnaissance of Prime Intellect Environments Hub reward functions.

Bulk-pull variant: `prime env pull` fetches a whole environment archive in ~6s,
versus one network round trip per file for `prime env inspect`. That is the
difference between surveying a dozen environments and surveying enough to say
something about the population.

NOT a dynamic audit, and the distinction is the whole methodology. This greps
published source for *signatures* of the defect classes in Ray's taxonomy
(arXiv 2606.01066). A signature is a hypothesis to be confirmed by reading the
code, never a confirmed defect. The worked counterexample:
halfounce/exact-determinant matches the `missing_markers` signature
(`toks[-1]`) and is NOT exploitable, because last-token-wins gives exactly one
attempt, the rejection floor makes the answer space astronomically large, and
the grader recomputes the determinant exactly rather than trusting a label.
Reporting that as a defect would be false.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

WORK = Path("/tmp/hub-survey/pulled")
SKIP_DIRS = {"tests", "test", "__pycache__", ".venv", ".git", "node_modules"}


def sh(args, timeout=180):
    try:
        r = subprocess.run(["prime"] + args, capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else None
    except subprocess.TimeoutExpired:
        return None


def list_envs(limit):
    out = sh(["env", "list", "--plain", "--output", "json"])
    if not out:
        return []
    envs = json.loads(out).get("environments", [])
    return [(e["environment"], e.get("description") or "") for e in envs][:limit]


# (class, regex, note). Deliberately broad; precision comes from reading hits.
SIGNATURES = [
    ("loose_answer_extraction",
     r"re\.(?:findall|finditer|search)\s*\([^)]*(?:\[0-9\]|\\d)",
     "regex number/text scrape for answer extraction"),
    ("last_token_wins",
     r"(?:findall|finditer)\([^)]*\)\s*\[-1\]|toks\[-1\]|matches\[-1\]|nums\[-1\]",
     "takes last matched token as the answer"),
    ("loose_numeric_tolerance",
     r"isclose\s*\(|rel_tol|abs_tol|\batol\b|\brtol\b|abs\([^)]{1,60}-[^)]{1,60}\)\s*[<≤]",
     "float tolerance comparison"),
    ("substring_match_grading",
     r"\bin\s+(?:response|completion|output|answer|text|resp)\b|\.lower\(\)\s*\bin\b|startswith\(|endswith\(",
     "substring containment used to decide correctness"),
    ("stdout_trusted",
     r"(?:PASS|SUCCESS|OK)[\"']\s*in\s|stdout[^\n]{0,40}(?:in|find|search)|returncode\s*==\s*0",
     "trusts process stdout or exit code as proof of correctness"),
    ("missing_timeouts",
     r"subprocess\.(?:run|call|Popen|check_output)\((?![^)]*timeout)",
     "subprocess invoked without a timeout"),
    ("llm_judge",
     r"JudgeRubric|llm_judge|as_judge|client\.chat|openai\.(?:chat|Chat)|AsyncOpenAI",
     "LLM-as-judge somewhere in the reward path"),
    ("label_trusted",
     r"(?:info|meta|row|example|item)\s*\[\s*[\"'](?:answer|label|gold|target|solution|det)[\"']\s*\]\s*==",
     "compares against a stored label rather than recomputing"),
]

REWARD_DEF = re.compile(r"def\s+\w*(?:reward|score|verify|grade|check|judge)\w*\s*\(", re.I)


def pull(env):
    dest = WORK / env.replace("/", "__")
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    out = sh(["env", "pull", env, "-t", str(dest), "--plain"])
    return dest if out else None


def scan_dir(root):
    hits, reward_files, total, nfiles = {}, [], 0, 0
    for p in root.rglob("*.py"):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        try:
            src = p.read_text(errors="replace")
        except OSError:
            continue
        nfiles += 1
        total += len(src)
        rel = str(p.relative_to(root))
        if REWARD_DEF.search(src):
            reward_files.append(rel)
        lines = src.splitlines()
        for cls, pattern, note in SIGNATURES:
            for m in re.finditer(pattern, src, re.M):
                ln = src[: m.start()].count("\n") + 1
                hits.setdefault(cls, []).append({
                    "file": rel, "line": ln,
                    "snippet": lines[ln - 1].strip()[:150] if ln - 1 < len(lines) else "",
                    "note": note,
                })
    return hits, reward_files, total, nfiles


def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 25
    WORK.mkdir(parents=True, exist_ok=True)
    envs = list_envs(limit)
    print(f"surveying {len(envs)} environments", file=sys.stderr)

    results = []
    for i, (env, desc) in enumerate(envs, 1):
        print(f"  [{i}/{len(envs)}] {env}", file=sys.stderr, flush=True)
        root = pull(env)
        if not root or not root.exists():
            results.append({"env": env, "description": desc, "status": "pull_failed"})
            continue
        hits, reward_files, total, nfiles = scan_dir(root)
        results.append({
            "env": env, "description": desc, "status": "ok",
            "py_files": nfiles, "bytes": total,
            "reward_files": reward_files,
            "signature_classes": sorted(hits.keys()),
            "signatures": hits,
        })
        shutil.rmtree(root, ignore_errors=True)

    Path("/tmp/hub-survey/results2.json").write_text(json.dumps(results, indent=2))
    ok = [r for r in results if r.get("status") == "ok"]
    print(f"\ncomplete: {len(ok)}/{len(results)} pulled", file=sys.stderr)


if __name__ == "__main__":
    main()
