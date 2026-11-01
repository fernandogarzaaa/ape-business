#!/usr/bin/env python3
"""
Driver: pull hub environments and audit them via the reward call graph.

Emits a direct comparison against the regex survey in HUB-001 so the value of
scoping is measurable rather than asserted.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

from ast_signatures import audit

WORK = Path("/tmp/hub-audit-work")


def sh(args, timeout=240):
    try:
        r = subprocess.run(["prime"] + args, capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else None
    except subprocess.TimeoutExpired:
        return None


def list_envs(limit: int) -> list[str]:
    out = sh(["env", "list", "--plain", "--output", "json"])
    if not out:
        return []
    return [e["environment"] for e in json.loads(out).get("environments", [])][:limit]


def main() -> None:
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    WORK.mkdir(parents=True, exist_ok=True)
    envs = list_envs(limit)
    print(f"auditing {len(envs)} environments", file=sys.stderr)

    results = []
    for i, env in enumerate(envs, 1):
        print(f"  [{i}/{len(envs)}] {env}", file=sys.stderr, flush=True)
        dest = WORK / env.replace("/", "__")
        shutil.rmtree(dest, ignore_errors=True)
        if not sh(["env", "pull", env, "-t", str(dest), "--plain"]):
            results.append({"env": env, "status": "pull_failed"})
            continue
        try:
            d = audit(dest)
            d["env"] = env
            d["status"] = "ok"
            d.pop("reachable", None)  # keep the report small
            results.append(d)
        except Exception as exc:
            results.append({"env": env, "status": "error", "error": f"{type(exc).__name__}: {exc}"})
        finally:
            shutil.rmtree(dest, ignore_errors=True)

    Path("/tmp/hub-audit-work/results.json").write_text(json.dumps(results, indent=2))

    ok = [r for r in results if r.get("status") == "ok"]
    with_roots = [r for r in ok if r["reward_roots"]]
    print(f"\n{len(ok)}/{len(results)} audited; {len(with_roots)} had locatable reward roots",
          file=sys.stderr)


if __name__ == "__main__":
    main()
