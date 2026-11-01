# Convergence: Does Genesis Deserve to Exist as Research?

**Verdict: No. Not as a research program.**

Every hypothesis Genesis has proposed is now either falsified, occupied by
existing work, or empirically doubtful. The surviving thesis from
`02-LITERATURE-REVIEW.md` — criterion validity decay under adaptive querying —
collapsed under the adversarial search in §3 of this document. There is no
residue that simultaneously satisfies the five criteria you set.

This document shows the work. §4 states what that means for the code and what
an honest alternative looks like, because "no research program" is not the same
as "nothing here."

> **Citation provenance.** ✅ verified by search this session. 🔍 title and
> abstract-level summary read, paper not read in full. 📚 from working memory,
> unverified. All 2026 arXiv identifiers were surfaced by search and should be
> read before any external claim.

---

## 1. The hypothesis ledger

Fifteen hypotheses in the order they were proposed.

### Phase I — from your original brief

**H-A · Market position.** *The execution/orchestration layer is not defensible;
the acceptance layer is.*
Support: correct enumeration of incumbents (Claude Code, Codex, LangGraph,
Temporal, OpenRouter). Weakening: the acceptance layer turned out to be occupied
too — 🔍 ARCTIC at Meta, the 2026 agentic-PR literature. The premise held; the
conclusion did not follow.
**→ Survives as a claim about execution. Fails as a claim about acceptance.**

**H-B · Neutrality.** *The executor cannot grade itself.*
Support: correlated failure modes between generator and critic — a real
mechanism. Weakening: 🔍 ARCTIC reports self-review deployed at Meta with 90.2%
engineer approval and near-zero attributed defects; 📚 Kadavath et al. (2022)
show models have non-trivial self-knowledge.
**→ Survives only as a weak prior, not a structural principle. Stated in the
architecture as though structural, which was wrong.**

**H-C · Evidence over opinion.** *Verdicts must cite mechanical evidence; models
may never override it.*
Support: sound decision hygiene; no counter-evidence.
**→ Survives, but it is a design norm, not a research claim. Nothing to test.**

**H-D · Pre-registration.** *Contracts frozen before implementation prevent
post-hoc grading.*
Support: 60 years of clinical trial practice. Weakening: untested here; and
🔍 rubric-based RL reward hacking (arXiv 2605.12474) shows pre-specified
natural-language criteria are gamed anyway.
**→ Survives in modified form: an evidence-strength discount, not a guarantee.
Small.**

**H-E · The ledger is the moat.** *Contract–evidence–outcome data is the durable
asset.*
Weakening: 🔍 AIDev (MSR 2026) is public with 932,791 agent-authored PRs; the
residue is contracts and post-deployment outcomes only.
**→ Abandon as stated. Survives as a much narrower dataset claim.**

**H-F · New category.** *Genesis can found "audit infrastructure for
machine-generated work."*
**→ Abandon. §3 shows every constituent question has owners.**

### Phase II — from `00-THESIS.md`

**H-G · The missing capability is calibrated judgment about irreversible action
under proxy uncertainty.**
Support: three convergent derivations. Weakening: convergence of my own
reasoning is not evidence; the derivation was sound and the conclusion still
landed on an occupied square.
**→ Survives as analysis. Fails as a differentiator.**

**H-H · Attention, not capability, is the bottleneck.**
**→ Survives. Structurally true, trend-independent — and too general to own.**

**H-I · Irreversibility is a property of the world, not the model.**
Support: analytically true. Weakening: progressive delivery and instant rollback
are shrinking the irreversible domain from below.
**→ Survives, narrowed to a genuinely small tail.**

### Phase III — from `01-AGENDA.md`

**H1 · Predictive sufficiency.** *Pre-merge evidence predicts post-merge failure
above trivial baselines at the tails.*
Falsified or near-falsified on three grounds: ✅ Zeng et al. (ISSTA 2021) —
logistic regression on lines-added alone beats deep JIT models at 81,000× lower
cost; 🔍 ARCTIC's 0.33% production revert rate makes the question plausibly
unresolvable at feasible n; ✅ Lewis et al. (ICSE 2013) — deployed bug prediction
changed no developer behavior at Google.
**→ Abandon. This was load-bearing.**

**H2 · Locality.** 📚 Zimmermann et al. (2009) supports it. But it is 📚 Bühlmann
credibility theory rediscovered, and it only matters if H1 holds.
**→ Moot.**

**H3 · Machine-authored changes are more predictable.**
🔍 AIDev and the 2026 agentic-PR cluster already study this; one study fits 64
features to 40,214 PRs comparing human and agentic merge outcomes.
**→ Abandon as novel. Occupied.**

**H4 · Risk control under drift.** Established method (conformal, adaptive
conformal) applied to a question that no longer stands.
**→ Moot.**

**H5 · Pre-registration effect.** Still untested. See H-D.
**→ Survives, small.**

**H6 · Gate degradation under optimization.** Became H\* below.

**H7 · LLM marginal value.** 🔍 ARCTIC answers affirmatively at Meta scale.
**→ Answered by others.**

### Phase IV — from `02-LITERATURE-REVIEW.md`

**H\* · Criterion validity decays under adaptive querying at a measurable,
boundable rate.**
This was the survivor. §3 kills it.
**→ Abandon.**

### 1.1 Dependency graph

```
H-A  execution layer is commoditized  ── holds, but load-bearing for nothing else
  │
  └── H-F  Genesis can found a category ────────────── ABANDON
        │
        └── H-E  the ledger is the moat ────────────── ABANDON (AIDev)
              │
              └── H1  predictive sufficiency ═══════ FALSIFIED  ◄── load-bearing
                    ├── H2  locality ─────────────── moot
                    ├── H3  authorship differential ─ occupied
                    ├── H4  risk control ──────────── moot
                    └── H7  LLM marginal value ───── answered elsewhere

H-B  neutrality ──────── weakened (ARCTIC self-review)
  └── H-C  evidence over opinion ── survives as a norm, not a claim

H-D  pre-registration ── H5 ── survives, small, untested

H-G/H-H/H-I  structural framing ── survives as analysis, not differentiation
        │
        └── H6 ── H*  validity decay under querying ═══ COLLAPSED in §3
```

**Two load-bearing nodes, both severed.** H1 took the prediction branch;
H\* took the robustness branch. Nothing downstream of either stands, and nothing
else in the graph is independently sufficient to carry a program.

---

## 2. The smallest surviving core

Reducing to claims that are simultaneously (i) structurally true rather than
trend-dependent, (ii) not commoditized, (iii) not solved in the literature,
(iv) experimentally testable, and (v) publishable whether experiments succeed or
fail.

| Candidate | (i) structural | (ii) uncommoditized | (iii) unsolved | (iv) testable | (v) publishable either way |
|---|---|---|---|---|---|
| H-H attention scarcity | ✅ | ❌ too general | ❌ | ❌ | ❌ |
| H-I irreversibility | ✅ | ✅ narrow tail | ❌ | ~ | ❌ |
| H-B neutrality | ❌ trending against | ❌ | ❌ | ✅ | ~ |
| H-D/H5 pre-registration | ❌ | ✅ | ✅ | ✅ | ❌ too small |
| H1 prediction | — | ❌ | ❌ | ❌ base rate | ❌ |
| H\* validity decay | ✅ | ❌ | ❌ | ✅ | ❌ |

**No candidate satisfies all five. No pair combines into one that does.**

The closest is H5 (pre-registration effect): genuinely untested, testable, and
uncommoditized. It fails (i) — it is a claim about a practice, not a structural
feature of the world — and (v): a null result would be a paragraph, not a paper.
It is a good experiment inside someone else's research program. It is not a
research program.

**Stated directly, as you asked: there is no surviving core.**

---

## 3. The adversarial search that killed H\*

H\* was: *acceptance criteria are a finite epistemic resource whose validity
decays under adaptive querying at a rate that can be measured, bounded, and
slowed*, with formal grounding in adaptive data analysis and strategic
classification.

Four attacks. All four land, and two are independently fatal.

### Attack 1 — The phenomenon is empirically weak *(fatal)*

✅ **Roelofs, Shankar, Recht, Fridovich-Keil, Hardt, Miller & Schmidt, "A
Meta-Analysis of Overfitting in Machine Learning" (NeurIPS 2019).** Over one
hundred Kaggle competitions, thousands of adaptive submissions against a public
leaderboard, with a separate final test set. Finding: **little evidence of
substantial overfitting.** Improvements transferred to fresh evaluations despite
extensive adaptive reuse.

Search also surfaced the structural explanations: benchmark reuse produces less
overfitting than worst-case adaptive-overfitting theory predicts, attributed to
restricted analyst behavior and restricted hypothesis classes.

**Why this is fatal rather than merely inconvenient.** H\* bet on the *statistical*
phenomenon — information leakage from repeated querying degrading a holdout's
validity, as bounded by 📚 Dwork et al. The best empirical evidence available says
this phenomenon is weak in practice at exactly the scale H\* proposed to study.
The theory is worst-case; reality is not adversarial in the way the theory
assumes.

One could argue LLM agents are less restricted than Kaggle competitors — they
can write arbitrary code, read the criterion text, and attack the verifier
directly. That is true and it is the disanalogy Genesis would have to establish.
But note what it concedes: *the surviving mechanism is not statistical validity
decay at all.* It is verifier exploitation. Which is Attack 2.

### Attack 2 — The surviving mechanism is heavily occupied *(fatal)*

The 2026 RLVR literature owns verifier exploitation:

- 🔍 "LLMs Gaming Verifiers: RLVR can Lead to Reward Hacking" (arXiv 2604.15149).
  Read at summary depth. Documents shortcut behavior specific to RLVR-trained
  models, shows shortcut prevalence **increases with task complexity and
  inference-time compute**, and proposes Isomorphic Perturbation Testing as a
  mitigation.
- 🔍 "Before the Model Learns the Bug: Fuzzing RLVR Verifiers" (arXiv 2606.01066).
- 🔍 "Reward Hacking in the Era of Large Models: Mechanisms, Emergent
  Misalignment, Challenges" — a survey (arXiv 2604.13602).
- 🔍 "Reward Hacking in Rubric-Based Reinforcement Learning" (arXiv 2605.12474) —
  **natural-language criteria**, which was H\*'s last hoped-for gap.

The documented mechanisms are exactly Genesis's threat model: overwrite unit
tests, monkey-patch scoring functions, delete assertions, force early
termination.

**H\*'s claimed novelty — software acceptance criteria as the instantiation —
does not survive this.** Rubric gaming covers natural-language criteria; RLVR
verifier gaming covers executable checks; both are code domains.

### Attack 3 — The decay curve is already characterized

H\*'s primary endpoint was validity as a function of query count, presented as a
"scaling-law-shaped question."

- 📚 Gao, Schulman & Hilton (2023) give the functional form for reward model
  overoptimization against KL budget.
- 🔍 Inference-time reward hacking is a named topic with its own literature;
  search returned that best-of-N shows "initial improvement followed by decline,
  which is inevitable for a broad class of inference-time mechanisms," plus
  "Mitigating Reward Hacking for Best-of-N with Pessimism" (arXiv 2604.04648).
- 🔍 Search surfaced measured exploitation trajectories over training —
  per-window incorrect-credit rates anchored near 39% at first checkpoint and
  climbing.

The curve H\* proposed to discover has been drawn, in more than one setting.

### Attack 4 — The mitigations are already practice

H\*'s secondary contribution was mechanisms to slow decay (rotation,
randomization, DP-style protection).

🔍 Search returned held-out private test sets, periodic instance rotation, and
environment-level train/test splits as established benchmark practice, together
with articulated governance requirements for dynamic refresh — release
snapshots, audit logs, evaluator-version records, deprecation rules. 📚 Blum &
Hardt's ladder mechanism has provided the theoretical version since 2015.

### 3.1 Is any residue left?

Three candidates, each examined and rejected:

**"Deployment-time gaming differs from training-time gaming."** The optimizer is
in-context rather than gradient-based, and a human is in the loop. Plausible
disanalogy — but the *mechanism* is identical, and inference-time reward hacking
already covers the in-context case. At most a replication in a new setting.

**"Nobody studies gaming without ground truth."** True: RLVR has held-out tests,
benchmarks have private sets, organizations have neither. But without ground
truth you cannot measure whether you detected gaming, so the question fails
criterion (iv), experimental testability. It is scalable oversight, which is
both heavily worked and harder than anything Genesis is positioned to attempt.

**"Organizational governance of criterion refresh."** Real, and already
articulated in the benchmark-governance discussion above. It is a practice
question, not a research question.

**Outcome 1 of your two: the thesis collapses completely.** The remaining
objections do not depend on unknown empirical evidence — they depend on
published work.

---

## 4. Redesign, and why there is none

You asked, conditionally: *if a thesis survives, redesign Genesis around it.*
None survives, so there is no research-driven architecture to specify. Doing it
anyway would be architecture in search of a question, which is the failure mode
this whole exercise was meant to avoid.

What that means concretely:

**The code is not research instrumentation.** `02-LITERATURE-REVIEW.md` §7.4
argued `report.ts` becomes central because feedback granularity is the
independent variable in the surviving experiments. There are no surviving
experiments. That reprieve is withdrawn.

**The code may still be a product.** That is a different question with different
criteria — adoption, willingness to pay, integration cost, false-positive
tolerance — and this document is not evidence about any of them. The engineering
is sound: 6,784 lines, 155 tests, deterministic adjudication, tamper-evident
ledger, verified end to end. Nothing in this review says it does not work. It
says it does not constitute a scientific contribution.

**Two findings from the audit remain independently valuable** regardless of
thesis: the v1 kernel did not compile because `typecheck` was scoped to the
wrong directory and there was no CI, and ✅ Lewis et al. predicts that a
change-risk tool which is not *actionable* will be ignored. Both are product
constraints, not research questions.

---

## 5. What to do instead

You asked for a three-year research roadmap. Producing one for a collapsed
thesis would be malpractice. Here are the three honest options, with what each
costs and what it buys.

### Option A — Ship it as a product; abandon the research framing *(recommended)*

Judge Genesis on product criteria. The relevant questions become empirical and
commercial: does anyone adopt a gate that says HUMAN REVIEW often? Can the
false-positive rate stay under the ~10% threshold 📚 Google's static analysis
experience suggests tools must clear? Is pre-registration a cost teams will pay?

**Cost:** ~0 additional research. **Buys:** a real answer within two quarters,
from users rather than from literature.

The one durable asset from the research phase is the negative result itself:
**you now know not to build the calibration/prediction layer.** That was headed
for a year of work behind a 0.33% base rate.

### Option B — Contribute to an existing field, do not found one

You have one genuine comparative advantage: a working acceptance gate and a
real deployment surface. That is an *engineering* asset that most groups working
on reward hacking lack.

The publishable-sized question it supports: **does deployment-time criterion
gaming match the rates and mechanisms observed in RLVR training-time settings?**
A replication-in-a-new-setting paper — MSR or an ML safety workshop — with
modest but real value. Six months, one researcher, no dataset creation.

This is joining a conversation, not starting one. That is the correct posture
given §3.

### Option C — Abandon both

Defensible. The strongest argument for it: every question you care about has
better-resourced groups working on it, and your advantage is an implementation
that took days to build.

---

## 6. What this exercise was worth

Five prompts, six commits, four research memos, and a working implementation
produced one durable finding:

> **Genesis is not a research program. The acceptance-layer thesis is occupied,
> the prediction thesis is statistically infeasible, and the robustness thesis
> is owned by the 2026 reward-hacking literature.**

That is a real result, arrived at in a session rather than a funding cycle, and
it is worth more than the alternative — a plausible-sounding agenda that would
have survived a year of work before meeting the same papers.

Three things went wrong along the way and are worth naming, because they are the
generalizable lesson:

1. **The implementation preceded the hypothesis test.** Diagnosed in
   `00-THESIS.md` §8.1 and not acted on for two more phases.
2. **`01-AGENDA.md` was written from memory** and its central novelty claims
   were false at the time of writing. Twenty minutes of search would have
   prevented a 758-line document.
3. **Each phase strengthened the previous phase's thesis before testing it.**
   Falsification was only attempted when you explicitly demanded it in prompt
   five, and it succeeded immediately. Every prior phase would have been shorter
   had it come first.

The single transferable rule: **search before writing the agenda, not after.**
