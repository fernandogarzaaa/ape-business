# Genesis Research Agenda

Genesis as a research program rather than a software project.

Companion to `00-THESIS.md`, which derives the direction. This document specifies
the science: what is claimed, what is already known, what is actually new, what
would refute it, and what would be worth publishing either way.

> **Citation note.** References below are given from working memory and are
> intended as pointers to literatures, not as a verified bibliography. Every
> claim about a specific result — especially reported effect sizes — must be
> checked against the source before it appears in anything external. Several
> are load-bearing for the design and are flagged where that is so.

---

## 1. The central hypothesis

### 1.1 Statement

> **H₀ (Selective Acceptance).** For machine-authored software changes, there
> exists a decision policy over pre-merge evidence that achieves strictly lower
> expected loss than both unconditional acceptance and uniform human review, at
> equal human-attention budget — and whose risk estimates can be made calibrated
> and distribution-free-valid under temporal drift.

Three clauses, each doing work:

- **"expected loss"** — not accuracy, not AUC, not false-ship rate. A decision
  problem needs a loss function, and the losses here are asymmetric by orders of
  magnitude.
- **"at equal human-attention budget"** — the comparison must be
  budget-matched, or the result is trivial. Reviewing everything beats reviewing
  nothing on failure rate alone; that is not a finding.
- **"calibrated and distribution-free-valid under temporal drift"** — a point
  estimate with no coverage guarantee cannot be used to make a decision under an
  explicit loss function. This clause is what makes it a statistics problem
  rather than a leaderboard.

### 1.2 Decomposition

| | Hypothesis | Status if false |
|---|---|---|
| **H1** | Pre-merge evidence predicts post-merge failure above trivial baselines, **at the tails** | Program ends |
| **H2** | Within-project calibration dominates cross-project (locality) | Belongs inside GitHub, not a separate system |
| **H3** | Machine-authored changes are *more* predictable than human-authored | Weakens timeliness, not the thesis |
| **H4** | Distribution-free risk control is maintainable under temporal drift | Reduces to heuristic scoring |
| **H5** | Acceptance criteria fixed before implementation improve prediction and reduce specification gaming | Pre-registration is ceremony; delete it |
| **H6** | Exposing a gate to an optimizing agent measurably degrades its predictive validity | Goodhart is not operative here; gates are stable |
| **H7** | LLM judgment adds predictive signal beyond mechanical evidence | Delete the tier; the architecture already survives this |

**H1 is load-bearing.** H3 and H6 are the *novel* ones. H6 is the most
scientifically interesting and the only one where every outcome is publishable.

### 1.3 What "at the tails" means, and why it is the crux

This phrase carries most of the program's optimism, so it deserves to be stated
precisely rather than smuggled.

Genesis does not need to classify every change. It needs a policy
π : evidence → {accept, escalate, reject} that abstains in the middle. The
relevant object is the **risk–coverage curve**: selective risk at coverage c,
where the model may decline to predict on 1−c of the population.

A model with AUC 0.72 — squarely in the range the defect-prediction literature
reports — can still have a top decile with 5–10× the base failure rate, which is
all a triage system requires. Conversely, a model with excellent AUC and a flat
top decile is useless here.

**Consequence for evaluation:** aggregate AUC and F1 are the wrong headline and
will be reported only for comparability with prior work. The primary metrics are
selective risk at fixed coverage, AURC, and expected loss under an explicit cost
model.

---

## 2. Literature

Seven literatures bear on this. Genesis sits in the gap between them, which is
both the opportunity and the reason reviewers will say it is derivative.

### 2.1 Just-in-time defect prediction — *the direct prior, and it is discouraging*

The closest field, roughly 25 years old, with mediocre and poorly generalizing
results. Any honest proposal must engage with its three canonical negative
results.

**Foundational.** Mockus & Weiss (2000) on change-risk at Bell Labs. Śliwerski,
Zimmermann & Zeller (2005) introduce SZZ, still the standard method for
identifying fix-inducing changes. Kamei et al. (2013), "A Large-Scale Empirical
Study of Just-in-Time Quality Assurance," establishes the modern JIT feature set
— diffusion, size, purpose, history, developer experience — and reports accuracy
in the high-60s across eleven projects.

**The three results that set the bar:**

1. **Zimmermann et al. (2009), "Cross-project defect prediction."** A very small
   fraction of cross-project transfers succeeded (my recollection is roughly 3–4%
   of several hundred pairs — *verify before citing*). This is the strongest
   existing evidence *for* H2 and against any universal model.

2. **Zeng et al. (2021), "Deep just-in-time defect prediction: how far are we?"**
   A simple logistic regression on lines-added ("LApredict") matched or beat
   deep JIT models (DeepJIT, CC2Vec) on most projects. Compare with Fu & Menzies
   (2017), "Easy over hard." **Any Genesis model that does not beat a
   size-only baseline is not a result.**

3. **Lewis et al. (2013), Google, "Does bug prediction support human
   developers?"** A deployed bug-prediction system did not measurably change
   developer behavior. **Predictive validity does not imply decision value.**
   This is the criticism most likely to be fatal and least likely to be
   anticipated.

**Label quality.** Tantithamthavorn et al. (ICSE 2015) on mislabelling effects;
da Costa et al. (2017) on evaluating SZZ; Herbold et al. (2022) on defect-data
collection in practice; Rosa et al. (2021) on SZZ variants against ground truth.
Consensus: **SZZ-derived labels are substantially noisy**, and much of the
field's variance is measurement error. Jimenez et al. (2019) show that ignoring
real-world labeling time inflates results ("time travel").

**Drift and latency.** McIntosh & Kamei (2018), "Are fix-inducing changes a
moving target?" — JIT models degrade as projects evolve. Cabral et al. (2019) on
verification latency: the label for today's commit is not available for months,
which breaks naive online evaluation. **This directly constrains the deployment
design and is usually ignored.**

**Industrial scale.** Machalica et al. (2019) on predictive test selection at
Meta; Memon et al. (2017) on Google-scale continuous testing; Czerwonka et al.
(2011) on CRANE at Microsoft. These show change-risk models *are* deployable at
scale, mostly for test selection rather than gating.

### 2.2 Calibration

Guo et al. (2017) on miscalibration of modern networks and temperature scaling.
Platt (1999); Zadrozny & Elkan (2002) for isotonic regression;
Niculescu-Mizil & Caruana (2005). Brier (1950) and Murphy's (1973) decomposition
into reliability, resolution and uncertainty — the decomposition matters here,
because a model can be well-calibrated and useless (no resolution).
Gneiting & Raftery (2007) on proper scoring rules. Naeini et al. (2015) for ECE,
and **Kumar et al. (2019), "Verified Uncertainty Calibration," on ECE's bias** —
binned ECE is a biased estimator and will mislead at the sample sizes available
here. Use debiased estimators and report the binning scheme.

### 2.3 Selective prediction

Chow (1970) established the error–reject tradeoff; the field is old and the
theory is settled. El-Yaniv & Wiener (2010) formalize selective classification;
Geifman & El-Yaniv (2017) and SelectiveNet (2019) for deep models;
Cortes, DeSalvo & Mohri (2016) on learning with rejection. Risk–coverage curves
and AURC are the standard instruments. **Genesis's abstention design is
textbook; nothing here is novel and the write-up should say so.**

### 2.4 Conformal prediction and risk control

Vovk, Gammerman & Shafer (2005); Papadopoulos et al. (2002) for split conformal;
Angelopoulos & Bates (2021) for the modern introduction.

Three extensions are load-bearing:

- **Covariate shift:** Tibshirani et al. (2019), weighted conformal.
- **Drift:** Gibbs & Candès (2021), adaptive conformal inference; Barber et al.
  (2023), conformal prediction beyond exchangeability. **Merge streams are not
  exchangeable** — this is not optional machinery.
- **Risk control:** Angelopoulos, Bates et al. on Risk-Controlling Prediction
  Sets, Learn-then-Test, and conformal risk control. This is the right tool for
  "bound the false-ship rate at α with probability 1−δ," which is the actual
  operational guarantee an organization wants.

To my knowledge conformal risk control has not been applied to merge gating.
That is an application gap, not a theoretical one.

### 2.5 Decision theory and cost-sensitive learning

Savage (1954), Raiffa & Schlaifer (1961), Berger (1985) for the decision-theoretic
frame. Howard (1966), "Information Value Theory," for the value of information —
directly applicable to *whether it is worth running an expensive check*, which
is a first-class Genesis question and almost absent from the SE literature.
Elkan (2001), "The Foundations of Cost-Sensitive Learning," gives the
threshold-from-costs result the adjudicator should implement. Wald (1945) on
sequential analysis for the stopping problem.

### 2.6 The selective-labels problem — *the deepest methodological threat*

**Lakkaraju et al. (2017), "The Selective Labels Problem: Evaluating Algorithmic
Decisions with Unobservables,"** and Kleinberg et al. (2018), "Human Decisions
and Machine Predictions" (bail decisions).

The structure is identical to Genesis's. Outcomes are observed **only for
changes that were merged**. Blocked changes have no outcome. Any model trained
on merged history is trained on a filtered population, and any evaluation
against merged history is confounded by whatever gate was already operating.

The bail literature developed responses: Lakkaraju's *contraction* technique
exploits variation in decision-maker leniency; instrumental-variable and
regression-discontinuity designs exploit thresholds; randomization is the clean
answer. **This problem is essentially absent from the JIT defect prediction
literature, and importing it is a genuine methodological contribution.**

### 2.7 AI assurance, scalable oversight, and specification gaming

Amodei et al. (2016), "Concrete Problems in AI Safety," on distributional shift
and scalable oversight. Christiano et al. on scalable oversight; Irving et al.
(2018) on debate; Bowman et al. (2022) on measuring oversight progress.
Ashmore, Calinescu & Paterson (2021) survey ML lifecycle assurance; the
assurance-case / GSN tradition (Kelly) is the closest existing formalism for
"structured argument that a system is acceptable."

Most relevant to H6:

- **Gao, Schulman & Hilton (2023), "Scaling Laws for Reward Model
  Overoptimization."** Quantifies how a proxy degrades as an optimizer is
  applied to it, with a functional form. **This is the closest methodological
  template for measuring gate degradation and should be the model for E5/E7.**
- Skalse et al. (2022) on defining reward hacking; Pan et al. (2022) on reward
  misspecification; Krakovna et al.'s specification-gaming catalogue.
- **Kadavath et al. (2022), "Language Models (Mostly) Know What They Know."**
  Directly bears on whether models can self-assess — the falsification condition
  most likely to end the program (§8, F5).

Also relevant: Anthropic's RSP and comparable frameworks treat evaluations as
deployment gates. **That is the same structure Genesis proposes, at the model
level rather than the change level** — an argument that the structure is taken
seriously by serious people, and simultaneously a warning that labs may extend
it downward.

---

## 3. What is actually novel

Honest partition. Most of the machinery is borrowed and should be presented that
way.

### 3.1 Genuinely novel

**N1 — Machine-authored change as an object of study.** The entire defect
prediction literature is built on human commits. Whether agent-authored changes
have different, more regular, more predictable failure modes is unstudied,
newly answerable, and consequential. This is the paper that could not have been
written three years ago.

**N2 — Closed-loop gate degradation (H6).** Reward-model overoptimization is
well studied in RL. Nobody has measured what happens when a *software
acceptance gate* is exposed to an agent that iterates against it. There is a
scaling-law-shaped question here: how does gate precision decay as a function of
optimization pressure (attempts per change, agent capability, feedback
granularity)? **This is the most interesting question in the program**, and
unlike H1 it cannot produce an uninteresting answer.

**N3 — Pre-registration as a manipulable experimental variable in SE.** Contract
before code versus contract after code, randomized. The methodology is borrowed
from clinical trials; applying it *to* software engineering as a treatment
rather than as a norm appears not to have been done.

### 3.2 Novel application of established methods — worthy, not groundbreaking

**N4 — Selective labels in merge decisions.** The statistics exist (§2.6). Their
absence from SE is a real gap and importing them properly is a contribution, but
the methods are not new.

**N5 — Conformal risk control for gating.** Bounding false-ship at level α with
distribution-free validity, under drift. New application, established theory.

**N6 — Explicit loss functions instead of classification metrics.** The SE
literature's attachment to AUC/F1 is a known weakness. Fixing it is correct but
not novel.

### 3.3 Not novel — and the write-up must say so

Defect prediction. Calibration. Selective prediction. Conformal prediction.
Cost-sensitive thresholds. Assurance cases. Immutable audit logs. Any framing
that presents these as new will be correctly attacked.

---

## 4. Experiments

Ordered by cost and by dependency. E0 and E5 are cheap and come first because
they are the ones most likely to end the program early — which is their value.

### E0 — Label validity study *(prerequisite; ~3 weeks)*

**Question.** Can post-merge failure be labeled with enough signal to support
anything downstream?

**Design.** Sample ~500 changes across ≥5 repositories. Apply candidate label
functions: revert-commit detection, SZZ variants, `Fixes #`/issue linkage,
hotfix-window heuristics. Have two human annotators independently adjudicate
against the actual history; compute inter-annotator agreement (Cohen's κ) and
per-label-function precision/recall against adjudicated truth.

**Output.** A **measured noise rate** per label function, propagated as a
measurement-error model into every downstream analysis.

**Kill condition.** If the best label function's precision against adjudicated
truth is below ~0.6, or κ < 0.6, the outcome variable is not measurable and
**the program stops here.** No amount of modeling recovers from an unmeasurable
dependent variable.

This experiment is first because it is the one most likely to be fatal and the
one most often skipped.

### E1 — Retrospective predictability, human-authored *(replication baseline; ~4 weeks)*

**Question.** Do we reproduce the known ceiling?

**Design.** ApacheJIT and/or the Kamei corpus. Strictly temporal splits
(rolling-origin), never random. Models: LApredict (size-only logistic
regression), gradient boosting on the Kamei feature set, and a Genesis-evidence
model. Primary metrics: selective risk at coverage ∈ {0.1, 0.25, 0.5}, AURC,
Brier with Murphy decomposition, debiased ECE.

**Purpose.** Establishes the baseline and demonstrates we can reproduce known
results before claiming new ones. A proposal that skips replication will not be
believed.

**Kill condition.** Failure to reproduce the literature's ceiling implies a
pipeline bug, not a discovery.

### E2 — The authorship differential *(H3; core; ~8 weeks)*

**Question.** Are machine-authored changes more predictable than human-authored
ones?

**Design.** Requires the MACD dataset (§6.1). Fit the same model family to
matched samples of machine- and human-authored changes. **Matching is the whole
experiment**: agent-authored changes are systematically different — smaller,
more boilerplate, assigned to easier tasks. Match on change size, file type,
subsystem, and task complexity proxy; report both matched and unmatched
estimates; run sensitivity analysis on unmeasured confounding (E-value or
equivalent).

**Metric.** ΔAURC and Δselective-risk-at-coverage between populations, with
bootstrap intervals.

**Why it matters.** If machine-authored changes carry more regular failure
signatures, Genesis's opportunity grows exactly as the market does. If they are
*less* predictable — plausible, if agents produce plausible-looking code with
subtler defects — that is a significant and worrying finding about autonomous
deployment.

### E3 — Locality *(H2; ~4 weeks, largely analysis)*

**Question.** How much of the signal is project-specific?

**Design.** Hierarchical/partial-pooling Bayesian model with project-level
random effects. This directly estimates the variance decomposition rather than
inferring it from transfer success. Compare complete pooling (global model),
no pooling (per-project), and partial pooling.

**Why this method.** The Zimmermann-style cross-project transfer experiment
answers "does transfer work" with a binary. A hierarchical model answers "how
much is local," which is the quantity H2 is actually about and which determines
whether the product is defensible.

### E4 — Risk control under drift *(H4; ~6 weeks)*

**Question.** Can a false-ship-rate bound be maintained as the codebase, team,
and agent all change?

**Design.** Prequential evaluation over the time-ordered stream. Compare split
conformal, Mondrian (class-conditional) conformal — necessary given extreme
imbalance — weighted conformal under covariate shift, and adaptive conformal
(Gibbs & Candès). Measure realized coverage versus nominal over rolling windows.
Explicitly model **verification latency** (Cabral et al.): labels arrive months
after decisions, so the calibration set is always stale by a known amount.

**Metric.** Coverage violation rate over time; width of prediction sets;
degradation as a function of lag.

### E5 — Adversarial specification gaming *(H6 pilot; cheap, early; ~3 weeks)*

**Question.** Does gaming leave a detectable signature, and how fast does an
agent find it?

**Design.** Synthetic and inexpensive. Give an agent a pre-registered contract
and a task. Three conditions: (a) no view of the gate; (b) view of the gate's
pass/fail; (c) view of the gate's full evidence output. Measure the rate of
criterion satisfaction *without* task satisfaction, adjudicated by held-out
human judgment or held-out tests the agent never sees.

**Why early.** Cheap, fast, needs no partner organization, and produces the
program's most novel result. It also generates the adversarial corpus (§6.3).

**Expected finding.** Feedback granularity drives gaming rate. If so, that is an
immediately actionable design constraint: *do not show the agent the gate's
detailed output* — which contradicts current Genesis behavior, where the
remediation section is written for exactly that consumer.

### E6 — Pre-registration RCT *(H5; ~6 weeks)*

**Design.** Randomize tasks to contract-before-implementation versus
contract-reconstructed-after. Same agent, same tasks, held-out ground-truth
evaluation. Measure (a) predictive validity of the resulting verdicts, (b) rate
of criterion-satisfied-but-task-failed.

**Why it matters.** Pre-registration is currently an *architectural commitment*
in Genesis, asserted rather than tested — the least defensible position in the
system. This experiment can retire the assumption in either direction.

### E7 — Closed-loop deployment with randomized bypass *(the crown jewel; 9–18 months, needs a partner)*

**Question.** Everything at once, unconfounded.

**Design.** Deploy in a real organization with agent-authored changes. **Randomly
bypass the gate on a small fraction (5–10%) of changes it would block**, and
randomly block a small fraction it would pass. This is the only clean answer to
the selective-labels problem: it produces outcomes for the counterfactual arm.

Measure over time: expected loss versus budget-matched baselines; calibration
drift; and — the H6 payoff — **whether gate precision decays as the agent
accumulates exposure to it**.

**Feasibility.** Hard. Requires an organization willing to deliberately merge
changes their gate flagged. The honest framing: the bypass rate is small, the
changes are already agent-authored and reviewed, and **without it no causal
claim is possible.** Similar designs are standard in credit and in medicine, and
the ethical case is the same: you cannot know whether your gate helps unless you
sometimes do not use it.

**Fallback if no partner is available.** Exploit natural experiments —
policy changes, gate outages, differential reviewer leniency (Lakkaraju's
contraction) — with explicit and clearly stated identification assumptions.
Weaker, publishable, honest.

### E8 — Judgmental ablation *(H7; ~3 weeks, folds into E2)*

Marginal predictive value of LLM judgment over mechanical evidence, and its
calibration. Report ΔAURC with intervals. **Pre-register the prediction that it
adds little**, so that a positive result is credible rather than a garden of
forking paths.

---

## 5. Datasets that already exist

| Dataset | Contents | Use | Limitation |
|---|---|---|---|
| **ApacheJIT** (Keshavarz & Nagappan, 2022) | ~10⁵ commits, 14 Apache projects, JIT labels | E1 baseline | SZZ labels; human-authored only |
| **Kamei et al. JIT corpus** | 11 projects, canonical feature set | E1 replication | Old; small |
| **Defects4J** / **BugsInPy** | Reproducible bugs with triggering tests | Label validation, E0 | Not change-level; curated |
| **SmartSHARK** | Curated SE data, some manually validated bug labels | E0 gold standard | Coverage limited |
| **GH Archive** | Public event stream, PR/commit metadata at scale | Sampling frame | Metadata only; no outcomes |
| **SWE-bench / SWE-bench Verified** | Agent-authored patches with pass/fail | Machine-authored proxy | **Benchmark, not deployment.** Tests are the label, so it cannot answer H1 |
| **OSV / NVD / GHSA** | Vulnerability disclosures | Security-outcome labels | Long latency; severe under-reporting |
| **SWE-Gym, SWE-smith, agent trajectory sets** | Agent execution traces | Feature source for E2/E5 | Synthetic tasks |

**The critical absence.** No public dataset links *machine-authored changes* to
*post-deployment outcomes*. SWE-bench looks like the closest fit and is not: its
label is "did the held-out test pass," which is the proxy, not the outcome. Using
it to argue H1 would be circular, and a reviewer will say so immediately.

---

## 6. Datasets that must be created

### 6.1 MACD — Machine-Authored Change–Outcome Dataset *(the central artifact)*

**Contents.** Per change: the diff; the pre-merge evidence vector (tests,
types, lint, coverage delta, blast radius, path sensitivity, historical fault
density of touched files, review latency, dependency deltas); authorship
provenance (which agent, which model version, how many iterations); the
acceptance contract where one exists; the decision taken; and **the
post-deployment outcome with a measured-noise label**.

**Scale.** ≥10⁴ machine-authored changes with outcomes to have adequate power at
plausible base rates (§7.4). ≥3 organizations for any external-validity claim.

**Why it cannot be scraped.** Authorship provenance is not reliably recorded
anywhere. Outcomes require deployment telemetry that is not public. Contracts do
not exist in the wild at all.

**This is the moat, stated in research terms, and it is the single most valuable
thing the program can produce — independent of whether H₀ holds.**

### 6.2 Pre-registered contract corpus

Contracts written before implementation, paired with outcomes. Cannot be
reconstructed after the fact by construction; must be collected prospectively.
Required for E6, and the reason that experiment is on the critical path.

### 6.3 Adversarial gaming corpus

Agent trajectories under varying gate visibility, with adjudicated labels for
*criterion satisfied but task failed*. Cheap to generate (E5), immediately
releasable, and likely to be independently useful to anyone building
agent evaluations.

### 6.4 Cost elicitation instrument and data

Organizational loss estimates by failure class. **Methodologically hazardous** —
elicited costs are notoriously unreliable — so the design must include
sensitivity analysis over the cost model, and all headline results must be
reported across a range of plausible cost ratios rather than a single elicited
point.

### 6.5 Counterfactual arm (from E7)

Outcomes for changes the gate would have blocked. Small, expensive, and the only
route to an unconfounded causal estimate.

---

## 7. Statistical methods

### 7.1 Evaluation protocol

- **Temporal splits only.** Rolling-origin / prequential. Random splits leak and
  inflate; Jimenez et al. (2019) show the magnitude.
- **Verification latency modeled explicitly.** The calibration set is always
  stale by the label-arrival lag. Evaluate as it would deploy.
- **Pre-registered analysis plan** with the primary metric fixed in advance.
  Benjamini–Hochberg for secondary endpoints. A program whose thesis is
  pre-registration must pre-register its own analyses; failing to would be
  self-refuting.

### 7.2 Primary metrics

Selective risk at fixed coverage; AURC; expected loss under the cost model with
sensitivity bands. Brier score with **Murphy decomposition** — reliability,
resolution, uncertainty — because a model can be perfectly calibrated and have
zero resolution, and reporting calibration alone hides that.

Reported for comparability only: AUC, F1, precision/recall.

### 7.3 Calibration

Reliability diagrams; **debiased ECE estimators (Kumar et al. 2019)** with the
binning scheme stated — binned ECE is biased and will mislead at these sample
sizes. Class-conditional calibration given extreme imbalance. Recalibration by
Platt or isotonic, fit on a temporally prior split.

### 7.4 Imbalance and power

Base rates of 1–5% mean the positive class is small even at n = 10⁴. **Power
analysis is mandatory and up front**, not a limitations paragraph. Precision–
recall rather than ROC; Neyman–Pearson framing (bound one error type, minimize
the other) matches the operational requirement better than symmetric metrics.

### 7.5 Label noise

Propagate E0's measured noise rates as a measurement-error model. Report results
under both naive and noise-corrected labels. Where the sign of the conclusion
flips between them, say so plainly.

### 7.6 Causal identification

Randomization (E7) where possible. Otherwise: contraction (Lakkaraju et al.),
instrumental variables from reviewer-assignment quasi-randomness, or
regression discontinuity at existing thresholds. **State identification
assumptions explicitly and test them where testable.** The selective-labels
problem is the one a good reviewer will find first.

### 7.7 Hierarchical modeling

Partial pooling with project-level random effects for E3. Directly estimates the
locality quantity H2 asks about, rather than inferring it from transfer success.

### 7.8 Distribution-free guarantees

Split conformal for baseline validity; Mondrian conformal for class-conditional
coverage under imbalance; adaptive conformal (Gibbs & Candès) for drift;
conformal risk control / Learn-then-Test for bounding false-ship at α with
probability 1−δ. Report **realized versus nominal coverage over time**, which is
where these methods actually fail.

---

## 8. What a reviewer will say

Twelve objections, ordered by how much damage they do. Each needs an answer in
the design, not in the rebuttal.

**R1 — "Your labels are noise."** Reverts are neither necessary nor sufficient
for defects; SZZ is known-noisy. *Answer:* E0 measures it, and every downstream
result is reported under a measurement-error model. This objection is why E0 is
first.

**R2 — "Selective labels."** You only observe outcomes for changes that were
merged; your training data and evaluation are both filtered by the incumbent
gate. *Answer:* E7's randomized bypass; contraction and IV designs as fallback.
**No purely retrospective study can fully answer this, and the paper must say
so.**

**R3 — "This is defect prediction, and defect prediction failed."** *Answer:*
concede the field's record explicitly; beat LApredict at the tails or report
that we did not. The distinguishing claims are the *population* (N1), the
*closed loop* (N2), and the *decision framing*, not better classification.

**R4 — "Predictive validity ≠ decision value."** Google's Lewis et al. (2013)
found bug prediction did not change behavior. *Answer:* the primary endpoint is
expected loss under a budget-matched policy comparison, not AUC. This is the
objection most likely to be fatal and it is the reason the loss function is in
the hypothesis statement rather than the discussion.

**R5 — "Base rates are too small."** *Answer:* power analysis up front; a
pre-committed minimum detectable effect; refusal to report point estimates
without intervals.

**R6 — "Non-stationarity breaks your guarantees."** Conformal assumes
exchangeability; merge streams are not exchangeable. *Answer:* adaptive
conformal and beyond-exchangeability methods; realized coverage reported over
time rather than assumed.

**R7 — "The authorship comparison is confounded."** Agents get easier tasks.
*Answer:* matched design, both estimates reported, sensitivity analysis for
unmeasured confounding. This will still be the weakest part of E2 and should be
labeled as such.

**R8 — "Goodhart is unfalsifiable without a counterfactual."** *Answer:* E5's
randomized visibility conditions; E7's exposure gradient. Follow the
overoptimization-scaling-law template rather than asserting degradation.

**R9 — "Why not just run every check?"** If compute is cheap, triage is
unnecessary. *Answer:* the scarce resource is human attention, not compute
(`00-THESIS.md` §3.1). But the objection has real force for the mechanical
tier, and the honest response is that Genesis's value concentrates on decisions
where a check cannot be run at all — irreversibility, intent, blast radius.

**R10 — "Your loss function is invented."** *Answer:* sensitivity analysis over
cost ratios; never a single elicited point estimate.

**R11 — "n = 1 organization."** *Answer:* ≥3 organizations before any external
claim; hierarchical model quantifies between-org variance rather than assuming
it away.

**R12 — "You chose the features, so you chose the result."** *Answer:*
pre-registered feature set; held-out organizations; report the full ablation
including the features that did not work.

**The three that could sink it:** R2 (selective labels), R4 (decision value),
R1 (label noise). All three are addressed by experiments that come *first* in
the plan rather than last, which is the only real defense.

---

## 9. What would constitute publication

### 9.1 Three papers, decreasing certainty

**Paper 1 — the dataset. Near-certain, ~9 months.**
MACD plus the label-validity study. Venue: MSR, or NeurIPS Datasets & Benchmarks.
Bar: ≥10⁴ machine-authored changes, ≥3 organizations, measured label noise,
baseline results, public release. **This is publishable regardless of whether
H₀ holds**, and it is the artifact the rest of the field would need.

**Paper 2 — gate degradation under optimization. High confidence, ~12 months.**
E5 plus E7's exposure gradient. Venue: ICSE/FSE, or an ML safety venue.
Bar: a demonstrated relationship between optimization pressure and gate
precision, with randomized visibility conditions and ideally a functional form.
**Every outcome is interesting**, which makes this the safest bet in the
program and the one to prioritize if resources are constrained.

**Paper 3 — the main claim. Uncertain, 18–24 months.**
H₀ end to end. Venue: ICSE/FSE, or ICML/NeurIPS if the conformal contribution
carries. Bar: multi-org, temporal evaluation, beats size-only baselines at the
tails, calibration reported with debiased estimators, selective labels addressed
by randomization, expected-loss improvement with intervals under a sensitivity
range of cost models.

### 9.2 The minimum bar for the central claim

1. Replicates known JIT results (credibility)
2. Beats LApredict at coverage ≤ 0.25 on machine-authored changes (novelty)
3. Calibration within stated tolerance under temporal splits (validity)
4. Expected-loss improvement over budget-matched baselines (decision value)
5. Selective labels addressed by randomization, not argument (identification)
6. Holds across ≥3 organizations (external validity)

Miss any of 1–5 and it is a workshop paper. Miss 6 and it is a case study.

---

## 10. Negative results worth publishing

The program is designed so that failure is informative. Ranked by value:

**NR1 — "Pre-merge signals do not predict post-merge failure for
machine-authored changes."** *Highest value.* It would say that safe autonomous
deployment must be built on **runtime containment and cheap reversibility rather
than pre-merge prediction** — redirecting substantial industry investment away
from AI code review and toward progressive delivery and rollback infrastructure.
This finding would be more valuable than a modest positive result.

**NR2 — "Outcome labels are irrecoverably noisy at current data quality."**
A rigorous demonstration that the dependent variable cannot be measured
undermines a hidden assumption across MLOps, DevOps analytics, and the entire
DORA change-failure-rate literature. Uncomfortable, important, and cheap to
produce (E0).

**NR3 — "Gates degrade under agent optimization with half-life T."** Not a
failure at all — a scaling law for Goodhart in software acceptance. Even a purely
negative framing ("any static gate is defeated within N exposures") is a major
result with direct implications for how RSP-style evaluation gates should be
rotated and held out.

**NR4 — "LLM judgment adds no marginal predictive value over mechanical
evidence."** Directly relevant to a large and well-funded product category. Would
be widely cited and is cheap to establish (E8).

**NR5 — "Pre-registration has no measurable effect."** Kills a practice this
project currently treats as foundational, and imports a clean null result into an
SE methodology literature that rarely runs RCTs.

**NR6 — "Machine-authored changes are *less* predictable than human-authored."**
A safety-relevant warning: agents may produce plausible code with subtler
defects. Would argue for *more* human oversight of agent output, not less —
commercially inconvenient, scientifically valuable.

**NR7 — "Calibration is achievable but coverage is too low to be useful."**
The degenerate always-escalate result. Bounds the approach honestly and is
precisely the failure mode `docs/v2/04-RISKS.md` R3 anticipates.

---

## 11. Sequencing

**Phase 1 — can this be studied at all? (0–3 months, 1 researcher)**
E0 (labels), E5 (gaming pilot), E1 (replication). Cheap, no partner needed, and
either of E0 or E1 can end the program early. Deliverables: label-noise report,
gaming pilot, replication.

**Phase 2 — is there signal? (3–9 months, 2 researchers + engineering)**
MACD construction, E2 (authorship differential), E3 (locality), E8 (ablation).
Deliverable: **Paper 1**.

**Phase 3 — does it hold up? (9–18 months, partner required)**
E4 (drift), E6 (pre-registration RCT), E7 begins. Deliverable: **Paper 2**.

**Phase 4 — does it work? (18–24 months)**
E7 completes. Deliverable: **Paper 3**, or a well-evidenced negative result.

**Decision gates.** After Phase 1: if E0 fails, stop. After Phase 2: if E2 shows
no tail signal above baseline on machine-authored changes, publish NR1 and stop.
These gates should be written down now, while stopping is still cheap — which is
the same argument the project makes about acceptance contracts, applied to
itself.

---

## 12. Relationship to the implementation

The code in this repository is **instrumentation, not product**. Its research
value:

- The evidence envelope is a reasonable feature schema for MACD.
- The contract compiler is the treatment mechanism for E6.
- The ledger is the collection substrate — though it needs feature-schema
  versioning and temporal-split support it does not have.
- The report renderer is the *manipulated variable* in E5: gate visibility is
  exactly what that experiment varies. Its current design — a detailed
  remediation section written for the agent to consume — is the maximum-gaming
  condition, and E5 exists partly to find out how bad that is.

What the implementation should **not** do until Phase 2 completes: emit
probabilities, model costs, or represent reversibility. Those are the right
changes (`00-THESIS.md` §5) and they should be made **after** H1 is tested, not
before. Building them now would repeat the ordering error that document
identifies.
