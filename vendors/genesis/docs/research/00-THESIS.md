# Genesis: A Research Direction

A first-principles reconsideration. Written against the current implementation,
not in defence of it.

The question posed: *if frontier AI systems become capable of autonomously
performing software engineering, what fundamental capability will still be
missing?*

The answer arrived at is not the one the current implementation assumes. The
current thesis survives, but only after being substantially rebuilt — and the
critique in §5 applies directly to code committed to this repository three
commits ago.

---

## 1. Discipline for the derivation

Most proposed answers to this question fail for the same reason, so it is worth
naming the failure mode before reasoning.

**A capability gap is not a thesis.** Any answer of the form "models cannot yet
do X" dissolves on the premise. We are told to assume frontier systems perform
software engineering autonomously. Anything downstream of raw model competence —
better planning, better debugging, better test generation, better code review —
is absorbed by the premise itself.

The surviving answer must be **structurally** missing: missing for reasons that
have nothing to do with how capable the model is. There are only a few sources
of structural persistence:

- **Properties of the world**, not the agent (irreversibility, causality, time)
- **Properties of value**, not fact (whose preferences count)
- **Properties of institutions** (who bears the loss)
- **Information that does not exist yet** (the future)

Any thesis must root in one of these or it has a shelf life measured in model
releases.

---

## 2. Candidates, and why most die

**Orchestration, routing, memory, tool use.** All capability gaps. All being
absorbed into the model layer as fast as they are named. Dead on the premise.

**Verification, in the naive form.** "The model can't tell if it's done."
Capability gap. If a model writes expert code it can write expert tests. Dead.

**Verification, in the independence form.** "The executor can't grade itself —
correlated failure modes." Better, and genuinely structural, but it argues for
*diversity of checkers*, which is a technique, not a category. You get most of
it by asking a different model. This is a feature, not a company, and certainly
not a research program.

**Specification.** "Code can be correct and still wrong, because correctness is
relative to a spec, and the spec is a lossy compression of intent." This is
structural — it roots in *value*, not capability. No amount of intelligence
derives what you wanted from what you asked for. This survives, and it will
come back in §3.

**Accountability.** "When a machine writes the code, who is responsible?" Roots
in institutions. Survives, but as currently posed it is a legal and
organizational question, not a technical one. It becomes technical only when
paired with something that produces evidence. Hold it.

**Continuity of judgment across time.** Interesting, underexplored, and it roots
in *information that does not exist yet*. Hold it.

Three candidates survive: specification, accountability, and the-future. They
turn out to be the same thing viewed from different angles.

---

## 3. The derivation

### 3.1 What becomes scarce

If AI makes *producing* software approximately free, the binding constraint
moves to whatever stays expensive. Three things do:

1. **Deciding what to build.** A value judgment. Doesn't scale with compute.
2. **Deciding whether what was built is acceptable.** Also a value judgment,
   and one that currently consumes human attention per unit of output.
3. **Bearing the loss when it is wrong.** Institutional. Doesn't scale at all.

None of these are capability problems. All three are bounded by **human
attention**, which is fixed, and by **human values**, which are not derivable
from the artifact.

This yields the first real observation:

> When generation becomes free, the bottleneck is not production. It is the
> human's finite capacity to decide what they wanted and confirm they got it.

Verification matters, but *not for the reason usually given*. It is not valuable
because machines are bad at checking. It is valuable because **human attention
is the scarce resource and verification is the mechanism that allocates it.**

That reframing is load-bearing. A verifier whose job is to catch bugs competes
with the model's own competence and loses over time. A verifier whose job is to
*decide where the human should look* is competing with nothing, because the
scarcity it addresses is not a model property.

### 3.2 What makes the allocation non-trivial

If every change were reversible, misallocated attention would cost only rework,
and the problem would be an optimization, not a science. It isn't, because of a
property of the world:

> **Irreversibility is a property of the world, not of the model.**

No amount of intelligence un-deletes a database, un-sends a payment, un-leaks a
credential, or un-breaks the trust of a user who churned. As autonomous systems
take more actions, with larger blast radius, at higher volume, the value of
accurate pre-action risk assessment grows **superlinearly** — volume multiplies
exposure while human review capacity stays flat.

This is why the humans are still in the loop. Not because they code better.
Because they are the entity that bears the consequences of irreversible acts,
and no one has built the instrument that lets them delegate that bearing
responsibly.

### 3.3 Why this cannot be solved by checking harder

Here the specification problem returns, sharpened.

Every check is a **proxy**. Tests are a proxy for correctness. Correctness is a
proxy for fitness for purpose. Review is a proxy for judgment. Coverage is a
proxy for thoroughness. Each proxy is a lossy compression of something we
actually care about, and the thing we actually care about — *did this turn out
well* — is not observable at decision time. It exists only in the future.

Two consequences follow, and they are the crux.

**First: there is no ground truth for "acceptable" at the moment of deciding.**
The only ground truth is what happened afterwards — shipped and held, reverted,
hotfixed, caused an incident, lost a customer, triggered a regulator. Any system
that renders acceptance decisions without ever comparing them to outcomes is
not measuring anything. It is performing a ritual with good production values.

**Second: exposing a proxy to an optimizer degrades it.** This is Goodhart, and
it is not a risk here, it is the design. An autonomous agent optimizing against
a stated criterion will satisfy the criterion. When generation was expensive,
proxy gaming was bounded by human effort. When generation is free, the proxy is
under continuous, cheap, tireless optimization pressure. **Proxy quality becomes
safety-critical infrastructure**, and proxy quality can only be established
empirically, against outcomes, over time.

### 3.4 The missing capability

Three independent lines — the scarcity of attention, the irreversibility of
consequence, the unverifiability of proxies — converge on one thing:

> **The missing capability is calibrated judgment about irreversible action
> under proxy uncertainty: knowing, with quantified and empirically validated
> confidence, whether a machine-authored change is safe to commit to — and
> knowing how much that confidence is worth.**

Every part of that sentence is doing work:

- **Calibrated** — the confidence must be *measured against outcomes*, not
  asserted. An uncalibrated confidence is a vibe with a number attached.
- **Irreversible** — reversible actions do not need this. The value scales with
  what cannot be undone.
- **Proxy uncertainty** — we never observe what we care about at decision time.
  The science is in the gap between proxy and outcome.
- **How much it is worth** — a decision requires a loss function. Without cost,
  "accuracy" is meaningless, because the costs are wildly asymmetric.

This does not dissolve as models improve. It gets *harder and more valuable*,
because capability increases volume, blast radius, and optimization pressure on
proxies simultaneously.

---

## 4. Why existing systems do not solve it

The systems named — Claude Code, Codex, Gemini CLI, Cursor, LangGraph, Temporal,
OpenRouter, LiteLLM — divide cleanly, and none of them are positioned to absorb
this.

**Execution agents (Claude Code, Codex, Cursor, Gemini CLI)** are structurally
disqualified from two of the four requirements. They cannot be calibrated
against outcomes because they do not persist past the task; the session ends,
the evidence evaporates, and no record links what they believed to what
happened. And they cannot be neutral about their own work — not for reasons of
honesty, but because a generator and a critic that share weights share failure
modes and share a prior about what "done" looks like. They will get better at
producing correct code. That is orthogonal.

**Orchestration (LangGraph, Temporal)** provides reliable execution of defined
workflows. Temporal will faithfully retry your deploy forever. Neither has any
representation of *whether the deploy should happen*. Control flow is not
judgment; a durable execution engine is agnostic about what it durably executes.

**Model routing (OpenRouter, LiteLLM)** optimizes cost and latency for
inference. Not adjacent.

**CI (GitHub Actions, Buildkite)** is the nearest neighbour and the most
important one to be precise about. CI runs checks and reports pass/fail. It has
three structural absences:

1. **No memory of outcomes.** CI never learns that the suite it ran green
   preceded three of last quarter's incidents. Every run is amnesiac.
2. **No calibration.** A failing lint rule and a failing integration test on the
   payment path are the same colour of red. There is no notion of what a signal
   is *worth*.
3. **No cost model.** Blocking is free in CI's model of the world. It is not
   free in the organization's.

CI is a *dispatcher of checks*. What is missing is a *learner over check
outcomes*.

**DevOps analytics (DORA metrics, Sleuth, LinearB, Jellyfish)** is the strongest
objection to novelty and deserves an honest hearing. These systems do relate
engineering signals to failure outcomes. The differences are real but narrower
than one would like:

- They measure **aggregate org health retrospectively**; they do not render a
  decision about an individual change.
- They **do not gate**. Their outputs inform humans quarterly; they are not in
  the path of an action.
- They have **no pre-registered hypothesis** — no statement, made before the
  work, of what would have constituted success.

The distinction is epidemiology versus a diagnostic test. Both study the same
relationship. Only one is an instrument you point at a patient. That is a real
distinction, but it is a distinction of *form*, not of subject matter, and any
honest positioning has to concede the adjacency.

**Formal verification** deserves a note because it is the one field that
genuinely solves a version of this — and its limits are instructive. Formal
methods prove a program satisfies a specification. They do not, and cannot,
establish that the specification is the right one. They collapse the
proxy-outcome gap by *assuming it away*, which is why they thrive exactly where
the specification is the whole product (protocols, kernels, avionics) and stall
everywhere the spec is a lossy statement of what someone wanted.

---

## 5. Verdict on the current implementation

The thesis in `docs/v2/01-ARCHITECTURE.md` is *directionally* right and
*structurally* wrong in six ways. Each critique lands on code in this
repository.

### 5.1 The output type is a category error

Genesis emits `SHIP | NOT_READY | HUMAN_REVIEW`. This throws away exactly the
information the thesis requires.

The correct output is a **calibrated probability of a bad outcome, with an
interval**, plus a decision derived by thresholding that probability against an
explicit loss function. A trichotomy is a decision with the reasoning deleted.
It cannot be scored (Brier, log loss), cannot be improved incrementally, and
cannot be composed with a cost model.

This does not sacrifice determinism, which was the property the trichotomy was
protecting. `P(bad outcome | evidence, model_version)` is perfectly
deterministic given a pinned model version, and it is *more* auditable, because
a miscalibration is visible in the numbers where a wrong bucket is not.

**The current `adjudicator/` is the wrong shape at the type level.** Its purity
discipline is right and should be kept. Its return type should be a distribution
and a loss-minimizing action, not a verdict enum.

### 5.2 There is no cost model, so the objective is wrong

A false SHIP on a copy change and a false SHIP on a payment path are the same
event in the current metrics. They are not remotely the same event.

`docs/v2/01-ARCHITECTURE.md` §7.2 congratulates itself for refusing "accuracy"
in favour of false-ship rate. That was the right instinct and it did not go far
enough: **false-ship rate is also wrong**, for the same reason. The objective is
**expected loss**, and expected loss requires the organization to state what
things cost. That statement is a first-class input the current design lacks
entirely.

### 5.3 Reversibility is not represented

If the thesis is about irreversible action, reversibility must be a primary
input — and the largest available lever. A change behind a feature flag with
instant rollback and a schema migration that drops a column are different
*kinds* of decision, not different scores on one scale.

The `diff` collector's blast-radius metrics gesture at this. It should be
central: **the cheapest way to make a risky change safe is to make it
reversible**, and a system that assesses risk without telling you that is
withholding its most actionable finding.

### 5.4 Pre-registration is treated as a rule when it is a dial

Pre-registration is borrowed from clinical trials, where it prevents endpoint
switching after seeing data. The analogous pathology here is real: an agent
writes code, then writes the criterion the code satisfies.

But pre-registration carries a cost the current design does not price. It
**assumes you know what success looks like before you start**. Much legitimate
engineering is exploratory, and a methodology that forbids learning while
building is wrong for a large fraction of real work.

The current implementation caps post-hoc contracts at `HUMAN_REVIEW` — the right
*mechanism* wearing the wrong *concept*. Pre-registration is not a compliance
rule that was violated. It is a **strength-of-evidence discount**: a post-hoc
contract yields a weaker posterior, and how much weaker is an empirical question
(H3, §7). Framing it as a rule makes it a ceremony to satisfy. Framing it as
evidentiary strength makes it a cost to trade against.

### 5.5 The ledger is over-engineered as a chain and under-engineered as a dataset

The hash chain is sound work and solves a real problem in adversarial and
regulated settings. It is an **engineering decision, not a research one**, and
in the research direction it contributes nothing.

What the thesis needs from the ledger is that it is a **labeled dataset linking
pre-decision evidence to post-decision outcomes**. Judged as a dataset it is
weak: no schema versioning for evidence features, no notion of a feature store,
no train/test discipline, no handling of label noise, no support for the
temporal splits that any honest evaluation requires.

### 5.6 The most serious flaw: outcome acquisition is an afterthought

Every claim rests on knowing what happened afterwards. In the current design
that is `genesis label --outcome reverted`, typed by a human who remembered.

**The moat is the outcome data, and the current architecture makes acquiring it
the least developed part of the system.** This inverts the priority. Outcome
acquisition — revert detection, hotfix linkage, incident correlation, rollback
telemetry, and the hard problem of label noise — should be the primary
engineering surface. Everything else is downstream of having the labels.

This is the clearest sign that the implementation was built in the wrong order,
which §8 takes to its conclusion.

---

## 6. The thesis, restated

Genesis survives, reframed. Not as an acceptance layer — that framing is static,
CI-adjacent, and positions Genesis as a gatekeeper competing with model
competence.

> **Genesis is an instrument for learning, from outcomes, what predicts failure
> in a specific system — and for pricing every machine-authored irreversible
> action against that knowledge.**

One sentence: *when machines take consequential actions, someone has to know the
odds; Genesis is the instrument that learns them.*

The category is not AI code review, and not CI. The mature form of this is an
**actuarial discipline**: a body of empirical knowledge, continuously
recalibrated, about what predicts loss — used to price decisions rather than to
forbid them.

The analogy is exact enough to be useful. Credit scoring, actuarial science,
clinical diagnostics, and aviation incident databases are all mature fields
built on the same structure: a decision under uncertainty about an irreversible
act, systematically calibrated against recorded outcomes. Each took decades and
each is now infrastructure.

**None of them exists for machine-authored artifacts.** That is the opportunity,
and the analogy tells you what the endpoint looks like, which is rare.

### What this buys that "acceptance layer" did not

- It **cannot be commoditized by model capability**, because it is a claim about
  a specific system's empirical failure distribution, not about reasoning quality.
- It **improves with volume**, which is precisely what autonomous agents
  generate. Every competitor's product creates this one's training data.
- It is **local**, so it does not sit in the path of any frontier lab. The
  mapping from signals to failure at a fintech is not the mapping at a game
  studio (H2, §7). Frontier labs will calibrate their models; they will not
  calibrate your codebase.
- It has a **research program**, not just a roadmap. There are questions here
  that can be answered wrongly.

---

## 7. Hypotheses, decisions, details, vision

The four categories the brief asked to be kept distinct. Confusing them is how
research programs turn into feature backlogs.

### 7.1 Research hypotheses — falsifiable, and possibly false

**H1 — Predictive sufficiency.** Pre-decision signals carry enough information
about post-decision failure to support useful selective escalation.
*Could be false:* failures may be dominated by exogenous factors (changed
requirements, upstream deprecations, load characteristics) invisible at decision
time. **This is the load-bearing hypothesis. If it fails, Genesis has no
product.**

**H2 — Locality.** The signal-to-failure mapping is sufficiently
organization- and codebase-specific that local calibration beats a global model.
*Could be false:* if universal signals dominate, this collapses into a feature
that belongs inside GitHub, and the defensibility argument evaporates.

**H3 — Pre-registration effect.** Contracts written before implementation
produce measurably better outcome-prediction than contracts reconstructed
afterwards, and measurably reduce specification gaming.
*Could be false:* agents may satisfy pre-registered criteria as
opportunistically as post-hoc ones, making pre-registration pure ceremony.
Note this is currently an **architectural commitment** in the implementation,
asserted rather than tested — the least defensible position in the system.

**H4 — Selective escalation dominance.** Calibrated selective escalation beats
both full automation and uniform human review on expected loss at fixed review
budget. *This is the product claim.* It is weaker than H1 — it can hold with
mediocre overall prediction, for the reason in §8.3.

**H5 — Judgmental marginal value.** LLM assessment adds predictive signal beyond
mechanical evidence. *Could be false, and we should want to know.* The current
architecture is explicitly built to survive H5 being false; that was correct.

**H6 — Gaming detectability.** Specification gaming leaves a statistical
signature detectable in the evidence record before the outcome arrives.
Speculative, and the most interesting one if it holds.

### 7.2 Engineering decisions — defensible, could be otherwise, not scientific

Hash-chained ledger. RFC 8785 canonicalization. SQLite. Deterministic pure
adjudicator. CLI-first. TypeScript. Process-boundary EVE integration. The
inadmissibility rule for executor-produced evidence.

All reasonable. **None of them is evidence the thesis is right**, and the
current documentation does not consistently maintain that distinction — several
passages argue for engineering choices in the register of principle.

### 7.3 Implementation details — replaceable without argument

Collector adapter formats, exit codes, report rendering, config schema, the
specific expectation operators. Wilson intervals are a detail; *reporting
uncertainty at all* is a principle.

### 7.4 Long-term vision — not commitments

Actuarial infrastructure extending beyond code to any irreversible machine
action: deployments, payments, communications, data deletion, physical actuation.
Cross-organization risk models with the structure of reinsurance. Regulatory
certification, where a calibrated acceptance record becomes the artifact an
auditor accepts. Standardized incident taxonomies for machine-authored change.

These are what the thesis implies if it holds. Building toward them now would be
building on an untested H1.

---

## 8. The smallest thing that could validate this

### 8.1 It is not what was built

Genesis currently has a working verifier: contract compiler, six collectors,
pure adjudicator, hash-chained ledger, CLI, 155 tests, green CI.

**None of it tests H1.**

To learn whether pre-decision signals predict post-decision failure, you need
three things, and a verifier is not among them:

1. A corpus of historical changes with extractable signals
2. Outcome labels for those changes
3. A predictive model and an honest evaluation protocol

That is a dataset and a notebook. It could have been done first, in a fraction
of the time, and it would have told us whether any of the rest is worth
building.

Stated plainly: **the product was built before the hypothesis it depends on was
tested.** The verifier is not wasted — it is the instrument that will *generate*
future data, and its evidence envelope is a reasonable feature schema. But it
was built in the wrong order, and the ordering error is the most important
finding in this document.

### 8.2 The minimal experiment

**Corpus.** 10-20 repositories with long, rich histories. Mix of languages and
domains, since H2 is exactly about whether that matters. Public repositories to
start — the labels are noisy but the data is free and the protocol is
reproducible.

**Labels.** Revert commits, hotfix linkage (`Fixes #`, revert-of-revert chains),
issue-to-commit correlation. Label noise is the central methodological threat
and must be quantified, not assumed away: the SZZ family of algorithms for
identifying failure-inducing commits is known to be noisy, and a study that
ignores this measures its own labeling heuristic.

**Signals.** Diff shape, blast radius, path sensitivity, test presence and
delta, coverage delta, historical fault density of touched files, author/agent
provenance, review latency, dependency changes, time-of-day. All cheaply
extractable from git.

**Protocol.** Strictly temporal splits — train on the past, test on the future,
never random splits, which leak. Report discrimination *at the tails*, not
aggregate accuracy (§8.3). Compare within-project against cross-project
calibration to test H2 directly. Report a "signals available at decision time
only" ablation.

**Cost.** Weeks, one researcher. No contracts, no ledger, no CLI.

**Decision rule.** If within-project selective prediction cannot beat trivial
baselines (change size, files touched) at the tails, H1 is in serious trouble
and the thesis needs rebuilding rather than refining.

### 8.3 The honest prior, and why it might still work

Intellectual honesty requires stating this: **just-in-time defect prediction is
a twenty-year-old research field with mediocre, poorly-generalizing results.**
Within-project AUCs typically land in the 0.7-0.8 range; cross-project transfer
degrades sharply, often toward random; and much of the literature rests on noisy
SZZ-derived labels. Genesis's central bet is not novel in kind, and any pitch
that does not say so is not being straight.

Four reasons to think the odds differ now, in descending order of strength:

**1. Selective prediction is a fundamentally easier problem than classification.**
This is the strongest argument and it is not merely rhetorical. Genesis does not
need to classify every change. It needs to identify the riskiest decile and the
safest decile with confidence, and abstain in the middle. Selective prediction
with an abstention option achieves useful precision at coverage levels where
full classification is hopeless. Most defect-prediction literature reports
metrics for the wrong task — the task Genesis needs is strictly easier, and the
literature's aggregate AUCs understate what is achievable at the tails.

**2. Machine-authored changes may be more predictable than human ones.** They
have more regular failure modes, less idiosyncratic variance, and — crucially —
systematic biases that recur. This is testable and, if true, is a tailwind that
arrives precisely as the market does.

**3. The contract provides supervised structure that historical work lacked.**
Defect prediction operates on unlabeled diffs. Genesis has a *stated intent* to
correlate against. That is a genuinely richer feature space than anything the
existing literature had access to.

**4. Volume.** Agents produce changes at rates that make within-project
calibration statistically tractable for the first time. The data problem that
constrained twenty years of this research is being dissolved by the same
technology that creates the need.

Reasons 1 and 3 are the load-bearing ones. Reasons 2 and 4 are plausible and
should be treated as such.

---

## 9. What survives, what dies, what becomes central

**Survives from the current implementation.** The evidence envelope with
provenance (a good feature schema). Executor/evaluator separation and the
inadmissibility rule. The purity discipline in adjudication. Outcome labeling as
a concept. Refusing to pool reconstructed with pre-registered contracts.
Reporting uncertainty.

**Dies or demotes.** The verdict trichotomy as the primary output — becomes a
thresholded view of a probability. Pre-registration as a universal rule —
becomes an evidence-strength discount whose magnitude is measured, not assumed.
The hash chain — good engineering, demoted out of the research narrative
entirely. The "acceptance layer" framing — too static, too CI-adjacent, and it
picks a fight with model capability that it loses over time.

**Becomes central, and mostly does not exist yet.** Outcome acquisition as the
primary engineering surface. An explicit organizational cost model.
Reversibility as a first-class input and the primary recommendation lever.
Calibration measurement — reliability diagrams, Brier scores, drift detection.
Temporal-split evaluation discipline. Label-noise quantification.

---

## 10. What would falsify this

A research direction that cannot be wrong is not one. The conditions under which
this should be abandoned:

1. **H1 fails.** Pre-decision signals do not predict post-decision failure at
   useful precision, in any repository, at any tail. Then the entire program is
   built on sand and should stop.
2. **H2 fails and universal models win.** The mapping is global, and the right
   home for it is inside GitHub or a frontier lab. Genesis should then become a
   dataset and a paper, not a company.
3. **Irreversibility gets cheap.** If perfect, instant, semantically-complete
   rollback becomes universal — every change reversible at zero cost — the
   value of pre-action assessment collapses toward zero. Worth watching:
   progressive delivery and instant-rollback tooling attack the thesis from
   underneath, and they are improving.
4. **Outcome labels prove unobtainable at acceptable noise.** If revert/incident
   labels cannot be produced with signal above the noise floor, no calibration is
   possible and the moat never forms. This is the most likely practical failure
   and it is measurable early.
5. **Frontier models become well-calibrated about their own work.** If a model
   can output reliable, empirically validated confidence on "will this cause an
   incident" — not stated confidence, *calibrated* confidence measured against
   outcomes — then the independence argument weakens considerably. Genesis would
   retain the outcome dataset and the institutional record, but the intellectual
   core would have moved into the model layer.

(5) is the one to watch most closely. It is not obviously far-fetched, and it is
the failure mode most likely to be mistaken for success by people inside the
project.

---

## 11. What to do next

**Do not build.** The verifier is sufficient to generate data and can sit
unchanged.

1. **Run the §8.2 experiment.** Weeks, not months. It answers H1 and H2, which
   between them determine whether there is a company, a paper, or neither.
2. **If H1 holds:** rebuild the adjudicator to emit calibrated probabilities,
   add the cost model, make reversibility a first-class input, and make outcome
   acquisition the primary engineering surface.
3. **If H1 fails:** publish the negative result. It is genuinely valuable — a
   rigorous demonstration that machine-authored change is not predictable from
   pre-merge signals would reshape how the industry thinks about autonomous
   deployment, and it would be the most useful thing this project could produce.

The success criterion for this program is not shipping software. It is knowing,
within a quarter, whether the central empirical claim is true — and being
willing to say so if it is not.
