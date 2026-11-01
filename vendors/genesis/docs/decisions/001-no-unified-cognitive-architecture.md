# DR-001: Genesis will not become a unified cognitive architecture

**Status:** decided against
**Date:** 2026-08-07
**Context:** proposal to rebuild Genesis as a combination of EVE, ADAM and AXIOM

Recorded because this proposal will recur. It is the natural place to return to
after a run of negative results, and the reasons against it are not obvious from
inside that moment.

---

## The proposal

Combine the three sibling projects — EVE (experience validation), ADAM
(self-evolving organism), AXIOM-AETHER (test-time training and compression) —
under Genesis as a unified cognitive architecture.

## Decision: no

### 1. This is v1, and it was correctly killed

`docs/v2/00-AUDIT.md` deleted `kernel/cognitive/{axiom,eve,adam}/` — 1,617 lines
implementing exactly this shape. The priority deletion was AXIOM, whose
`simulate()` asked a model for its own success rate and regex-scraped a
percentage out of the prose.

More to the point, the instruction to kill it came from the project owner, in
this project's founding brief: *"the execution/orchestration layer is not the
defensible product… Genesis should NOT compete there."* Nothing found since has
weakened that. `05-COMPETITIVE-SCAN.md` strengthened it.

Reversing a founding decision requires new evidence. There is none.

### 2. The integration already exists and is called MCP

All three projects already ship MCP servers:

| Project | Surface |
|---|---|
| EVE | `eve-mcp` binary — `eve_run_session`, `eve_compare_builds`, `eve_get_report`, … |
| ADAM | `adam-mcp` crate — 12 `adam_*` tools over JSON-RPC/stdio |
| AXIOM-AETHER | `axiom_mcp` crate — ~20 stdio/HTTP tools |

An agent can call all three **today**, with no new code. A unified cognitive
architecture would rebuild, in a fourth codebase, what a published protocol
already provides — and would then have to be maintained against three
independent release cadences.

If the goal is "these should work together," that is a `.mcp.json` file, not an
architecture.

### 3. They do not compose

| | Subject | Language |
|---|---|---|
| EVE | A running web application, probed by a simulated human | TypeScript |
| ADAM | An organism with a genome, memory, skills, governance | Rust |
| AXIOM-AETHER | Inference-time compression, TTT, grounding proxy | Rust + Python |

Three languages, three unrelated problems, three separate products with their own
users. What they share is a naming scheme and an author.

Unification here is an integration project with no user asking for it. The
combined system would be harder to explain than any of its parts, and each part
would ship more slowly.

### 4. The one-line test

*Who is worse off tomorrow if this does not exist?*

For the unified architecture: nobody. Each project keeps working. No user is
blocked on their combination.

---

## What is genuinely worth unifying

**EVE and `src/assurance/` are the same machine built twice.** Both are: fire
synthetic inputs at a target, score the responses, emit structured findings with
evidence. Two codebases, two CLIs, two finding schemas, two report renderers, no
shared engine.

That unification has a real justification — one probe engine, pluggable probes
and subjects — and it is a refactor, not an architecture. ADAM and AXIOM do not
fit that pattern and should stay where they are.

Prerequisite: at least one of the two tools should meet a real user first.
Unifying two things nobody uses yet produces one thing nobody uses.

---

## The pattern worth naming

Four theses have been retired in this project: the acceptance layer, the
prediction thesis, the robustness thesis, and environment assurance. Each was
killed by under an hour of literature search.

After a run like that, the pull back toward the original grand idea is strong,
because it is the last place that still felt like it had a future. But the
original idea is not untested — it is the *most* tested thing here. It was
audited first, deleted first, and its deletion is the one decision nothing since
has challenged.

The missing ingredient has never been architecture. It is that **nothing built
here has met a user.** Five sessions, roughly 13,000 lines, four theses, zero
external contact. A unified cognitive architecture would extend that streak by
several months.
