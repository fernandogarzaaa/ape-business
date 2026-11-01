# Literature and Conceptual Review

An attempt to kill Genesis with existing work before trying to strengthen it.

**Outcome: the thesis as stated in `00-THESIS.md` and `01-AGENDA.md` does not
survive.** A substantially narrower thesis does, and it is better than what it
replaces. §7 gives the verdict; §4 shows the work.

> **Provenance of citations.** Items marked ✅ were verified by search during
> this review. Items marked 📚 are from working memory and still require
> verification. Items marked 🔍 were surfaced by search but only their title,
> venue and abstract-level summary were read — the papers themselves were not.
> Two papers (ARCTIC, the auditee-gaming benchmark) were fetched and read at
> summary depth. This distinction matters: several ✅ and 🔍 findings below
> reverse conclusions reached in `01-AGENDA.md`, which was written entirely
> from memory.

---

## 1. The adjacent field map

Twelve fields study problems structurally similar to Genesis's. The first four
were anticipated in `01-AGENDA.md`; the rest were not, and three of them supply
better formal machinery than anything that document proposed.

| Field | Core question | Relevance |
|---|---|---|
| **Just-in-time defect prediction** | Will this commit induce a fix? | Direct prior. Discouraging record. |
| **Calibration / uncertainty quantification** | Do stated probabilities match frequencies? | Method supply |
| **Selective prediction** | When should a model abstain? | Method supply; settled theory |
| **Conformal prediction & risk control** | Distribution-free coverage guarantees | Method supply |
| **Adaptive data analysis** | How many adaptive queries can a holdout survive? | **The missing formal home** |
| **Strategic classification / performative prediction** | Classification when the classified party manipulates features | **The missing formal home** |
| **Selective labels / econometrics of decisions** | Evaluating decisions when outcomes are observed only for one arm | Identification |
| **Credit scoring & reject inference** | 50 years of the selective-labels problem in production | Underused analogue |
| **Clinical prediction models** | Is a prognostic model clinically useful? | **Better methodology than SE uses** |
| **Actuarial credibility theory** | How much to trust individual vs. group experience? | Solves the locality question |
| **Runtime verification / progressive delivery** | Detect and revert instead of predict | **Competing solution** |
| **AI assurance & evaluation gaming** | Do evaluations remain valid under optimization? | Nearest sibling |

### 1.1 The three fields `01-AGENDA.md` missed

**Adaptive data analysis.** ✅ Dwork, Feldman, Hardt, Pitassi, Reingold & Roth,
"Preserving Statistical Validity in Adaptive Data Analysis" (STOC 2015) and
"The reusable holdout" (*Science*, 2015). The question is exactly Genesis's:
when an analyst repeatedly queries a holdout and adapts based on answers, the
holdout's validity degrades — and the paper gives quantitative bounds plus a
mechanism (differential-privacy-based noise) for preserving it across many
queries. 📚 Blum & Hardt's "The Ladder" (ICML 2015) does the same for
competition leaderboards.

**An acceptance gate queried repeatedly by an agent is a reusable holdout.**
That framing was absent from both prior documents and it is the single most
useful thing this review found.

**Strategic classification and performative prediction.** ✅ Hardt, Megiddo,
Papadimitriou & Wootters, "Strategic Classification" (ITCS 2016) formalizes
classification when the classified party manipulates features to obtain a
favorable outcome. ✅ Perdomo, Zrnic, Mendler-Dünner & Hardt, "Performative
Prediction" (ICML 2020) generalizes it: predictions that influence the outcomes
they predict. Search confirms strategic classification is a special case of
performativity.

Genesis's gate is performative by construction — it changes the distribution of
changes submitted to it. `01-AGENDA.md` called this "closed-loop gate
degradation" as though naming a new phenomenon. It has a formal literature.

**Clinical prediction modelling.** 📚 Steyerberg's and Harrell's prognostic
model tradition, the TRIPOD reporting guideline, and — most relevant — Vickers
& Elkin's decision curve analysis (2006), which asks *net benefit across a range
of decision thresholds* rather than AUC. This is precisely the "predictive
validity ≠ decision value" instrument `01-AGENDA.md` groped toward under R4.
Medicine solved the reporting problem for this class of question two decades
ago; SE largely has not.

### 1.2 Two more that matter

**Actuarial credibility theory.** 📚 Bühlmann credibility gives a century-old
answer to H2 (locality): how much weight to place on individual versus
collective experience, as a function of within- and between-group variance. The
hierarchical model proposed in E3 is a rediscovery of this. Fine — but it should
be cited as such.

**Credit scoring's reject inference.** 📚 Hand & Henley (1997) and the reject
inference literature address exactly the selective-labels problem in production
at scale: you only observe repayment for applicants you approved. SE's defect
prediction literature has essentially ignored this; consumer credit has fifty
years of practice.

---

## 2. Genesis against the strongest work in each field

### 2.1 Defect prediction — Genesis loses on the baseline

✅ **Zeng, Zhang, Zhang & Zhang, "Deep Just-in-Time Defect Prediction: How Far
Are We?" (ISSTA 2021).** Verified precisely: `LApredict` — logistic regression
on *lines added alone* — outperforms DeepJIT and CC2Vec, and is 81,000×/120,000×
faster to train/test. Neither deep model consistently beat traditional JIT
prediction under within- or cross-project settings.

**Consequence for Genesis.** The evidence envelope — tests, types, lint,
coverage delta, EVE sessions — must beat a single integer already captured by
the `diff` collector. Nothing in the architecture justifies confidence that it
will, and the burden is entirely on Genesis.

✅ **Lewis, Lin, Sadowski, Zhu, Ou & Whitehead, "Does Bug Prediction Support
Human Developers? Findings from a Google Case Study" (ICSE 2013).** Verified:
deployed at Google, **no identifiable change in developer behavior**. The
authors attribute the failure to the system not presenting *actionable*
messages.

**Consequence.** Genesis's report is prose plus artifact digests. The one prior
attempt to put change-risk information in front of developers at scale changed
nothing. Genesis has no evidence it does better, and its remediation section is
of the same species as the thing that failed.

**One point in Genesis's favour, previously unnoticed.** 📚 Predictive test
selection is deployed successfully at Meta (Machalica et al., 2019) and Google.
That is the *same underlying change-risk signal*, used to allocate **compute**
rather than **human attention**. So the weak form of H1 — changes carry risk
signal — has arguably already been validated industrially. The failure is
consistently at the *decision layer*, not the *prediction layer*, which is
exactly what Lewis et al. found.

### 2.2 Agentic software engineering — the field moved while Genesis was being built

This is where the review does the most damage. `01-AGENDA.md` claimed
machine-authored change was an unstudied object (N1). **That claim is false as
of 2026.**

🔍 **AIDev (Li et al., MSR 2026, arXiv 2602.09185).** 932,791 agent-authored
PRs from five agents (Codex, Devin, Copilot, Cursor, Claude Code) across 116,211
repositories and 72,189 developers, with a curated 33,596-PR subset including
comments, reviews, commits and linked issues.

🔍 A cluster of 2026 studies already works this seam: "How AI Coding Agents
Modify Code" (2601.17581); "Where Do AI Coding Agents Fail?" (2601.15195);
"Understanding the Rejection of Fixes Generated by Agentic Pull Requests"
(2606.13468); "Security in the Age of AI Teammates" (2601.00477); "More Code,
Less Reuse" (2601.21276); "Human-Written vs. AI-Generated Code: A Large-Scale
Study of Defects, Vulnerabilities, and Complexity". One fits 64 features across
six families to 40,214 PRs to compare human and agentic merge outcomes — which
is a substantial part of experiment **E2**, already done.

**Consequences.**
- **N1 is dead.** Machine-authored change is an actively studied object.
- **MACD is largely superseded** for the change-plus-metadata portion. What
  AIDev appears to lack: post-*deployment* outcomes (it has merge outcomes, and
  merge ≠ success), pre-registered contracts, and evidence vectors from
  independently executed checks. That residue is a real but much smaller
  contribution than "the central artifact."
- **E2 must be reframed** as replication-plus-extension, not discovery.

### 2.3 ARCTIC — the strongest single threat

🔍 **"From Code Review to Code Critique: Intent, Drift, and Spotlight for
AI-Generated Diffs at Scale" (Meta, 2026, arXiv 2607.29516).** Read at summary
depth. It infers developer intent from conversation logs, detects divergence
between intent and diff by backtranslation, and ranks regions for review
priority using a taxonomy from 18,000 human reviews. Reported: QWK 0.907 against
human raters on a 118-diff benchmark; 90.2% engineer approval of intent
predictions; deployed at Meta scale.

This is Genesis's judgmental tier — *intent versus artifact* — built, deployed,
and validated by a large organization.

Two things Genesis still has that ARCTIC does not: it works **retrospectively**
(intent inferred after the fact, explicitly not pre-registered), and it has no
frozen, hashed commitment against which drift is measured.

But the reported **0.33% revert rate** is the most damaging number in this
review, and not for the reason it first appears.

### 2.4 The base-rate problem, quantified

At a 0.33% revert rate:

- ~30,000 changes yield ~100 positive cases.
- A meaningful difference in tail selective risk needs positives in the *tail*,
  not the sample — perhaps 10–20 events in the top decile.
- Confidence intervals at these counts are enormous. `01-AGENDA.md`'s power
  analysis worry was correct and understated.

📚 Combined with known SZZ label noise, the signal-to-noise ratio may be below
what any study of realistic size can resolve. **This is close to a fatal
statistical objection to the prediction thesis**, and it arrives from a
production system, not a model.

### 2.5 Runtime verification and progressive delivery — the competing solution

📚 Canary analysis (Netflix's Kayenta and similar), feature flags, progressive
delivery, and automated rollback are mature and improving. Their thesis is the
opposite of Genesis's: **do not predict failure, detect it in minutes and
revert.**

Where mean-time-to-recovery approaches zero, the value of pre-merge prediction
approaches zero with it. Every dollar spent making changes reversible reduces
the value of predicting which are dangerous, and industry is spending those
dollars.

Genesis's counter — that irreversibility is a property of the world — holds
only on the *irreversible tail*: schema migrations, credential exposure,
external side effects, regulated filings. **That is a much narrower domain than
"all code changes," and the honest framing is that progressive delivery is
eating the middle of Genesis's market from below.**

### 2.6 Evaluation gaming — nearest sibling, and partially occupied

🔍 **Burnat & Davidson, "A Benchmark for Strategic Auditee Gaming Under
Continuous Compliance Monitoring" (2026, arXiv 2605.06340).** Read at summary
depth. Benchmarks how evaluation mechanisms fail under adversarial optimization
by the audited party; measures degradation in evaluation validity when
compliance gates face an intelligent adaptive adversary.

**Consequence.** `01-AGENDA.md`'s N2 — closed-loop gate degradation as an
unstudied phenomenon — is **overstated**. The phenomenon has a 2026 benchmark.

What remains distinct: their domain is AI auditing and compliance, with an
organizational auditee. Genesis's would be *software acceptance criteria*, with
a code-generating agent, iterating at machine speed, in a domain that supplies
**ground-truth outcomes and executable checks**. Adjacent, not identical — and
the novelty claim must be stated at that resolution rather than as ownership of
the phenomenon.

---

## 3. Component classification

Every component of Genesis, honestly sorted.

### 3.1 Well established — use, cite, do not claim

| Component | Established as |
|---|---|
| Selective escalation (three-way abstention) | Chow (1970); El-Yaniv & Wiener (2010) |
| Calibration and reliability reporting | Platt; Zadrozny & Elkan; Guo et al. (2017) |
| Distribution-free coverage | Vovk et al.; Angelopoulos & Bates |
| Cost-derived decision thresholds | Elkan (2001) |
| Hash-chained append-only log | Merkle; certificate transparency; standard |
| Canonical serialization (RFC 8785) | Standard |
| Evidence with provenance | Assurance cases (Kelly); supply-chain attestation (in-toto, SLSA) |
| Immutability of a graded artifact | Clinical trial pre-registration; a 60-year-old norm |
| Change-risk features | Kamei et al. (2013) — Genesis's feature set is a subset |

### 3.2 Engineering combination of known ideas

- **The four-stage pipeline** (contract → evidence → adjudication → ledger).
  Each stage established; the assembly is competent integration, not research.
- **Deterministic pure adjudicator.** Good engineering, and a genuine
  precondition for replay-based calibration — but a design property, not a
  finding.
- **Falsifiability validation** (rejecting unbounded predicates, contradictory
  expectations, non-binding-only contracts). Sound, small, and roughly what a
  linter for assurance cases would do.
- **Contract–outcome ledger.** The concrete asset. Its value is entirely
  empirical and entirely contingent on §2.4's base-rate problem being
  surmountable.

### 3.3 Genuinely novel — the surviving list, much shorter than claimed

1. **Pre-registration as a manipulable experimental treatment in software
   engineering.** ARCTIC explicitly infers intent retrospectively; AIDev has no
   contracts; the JIT literature has none. Randomizing contract-before versus
   contract-after remains, to my knowledge, undone.
2. **Acceptance criteria analyzed as a reusable holdout under adaptive
   querying.** Importing Dwork et al.'s bounds and DP-based protection into
   software acceptance gates. Neither the adaptive-data-analysis literature nor
   the SE literature appears to have made this connection.
3. **Software acceptance as an empirical testbed for evaluation robustness**,
   distinguished from the compliance-auditing setting by executable checks and
   ground-truth outcomes.

Items 2 and 3 are the strong ones. Item 1 is real but small.

### 3.4 Based on a false or unsupported assumption

**"The executor cannot grade itself."** — *Substantially undermined.* ARCTIC
reports self-review deployed at Meta with high engineer approval and low
attributed defect rates. 📚 Kadavath et al. (2022) show models have non-trivial
knowledge of their own reliability. The premise is stated in Genesis as
structural; the evidence suggests it is empirical, contested, and trending
against. **The admissibility rule that excludes executor-produced evidence is
therefore a design choice defended by an assumption that the field is currently
falsifying.**

**"Absence of evidence must yield escalation."** — *Decision-theoretically
sound, operationally doubtful.* At a 0.33% base rate with an escalation-heavy
lattice, the human review budget is exhausted long before the tail is reached.
Sound rule, possibly infeasible policy.

**"Pre-registration improves acceptance quality."** — *Untested, and it is an
architectural commitment.* Unchanged from `01-AGENDA.md` §H5, and now the
weakest load-bearing assumption in the system.

**"Machine-authored changes are an unstudied population."** — *False.* §2.2.

**"The ledger is the moat."** — *Weakened.* AIDev is public, large, and covers
much of the same ground. The moat is not change data; at best it is
*contract-and-outcome* data, which is a far narrower claim.

---

## 4. Falsification attempt

Six attempts, strongest first. Two land.

**F1 — The size baseline (Zeng et al.). ✅ Lands.**
If lines-added dominates, Genesis's evidence collection is expensive
decoration. Genesis has no argument that its richer evidence beats an integer,
and the burden is on Genesis. *Survives only as an open empirical question, with
the prior against.*

**F2 — Base rate × label noise (ARCTIC's 0.33% + SZZ noise). 🔍/📚 Lands.**
The prediction thesis may be **statistically unresolvable at any feasible
study size**. This is the most serious objection in the review and it did not
appear in either prior document. *No available answer within the prediction
framing.*

**F3 — Decision value (Lewis et al.). ✅ Lands hard.**
The one prior attempt to deploy change-risk information to developers at scale
produced no behavior change. Genesis differs by attaching a *decision* rather
than *information* — which is a real difference, and also exactly what makes
false positives costly enough to get the system turned off. 📚 Google's static
analysis experience (Sadowski et al.) suggests developers abandon tools above
roughly a 10% false-positive rate. *Genesis has no evidence it clears that bar.*

**F4 — Progressive delivery. 📚 Lands on the middle of the market.**
Cheap reversibility is a substitute good, and it is improving. *Survives only on
the irreversible tail — a genuine but much smaller domain.*

**F5 — Prior occupancy (AIDev, ARCTIC, auditee-gaming benchmark). 🔍 Lands on
the novelty claims, not the thesis.** N1 dead; N2 overstated; MACD largely
superseded. *The remaining novelty is items 1–3 of §3.3.*

**F6 — Self-assessment improving (ARCTIC self-review; Kadavath et al.). Partial.**
The neutrality premise is weakening. *Genesis's separation-of-concerns argument
should be presented as a hypothesis to test, not a principle to assume.*

### 4.1 What the falsification attempt leaves standing

The **prediction** thesis — *Genesis can tell you which machine-authored changes
will fail* — does not survive F1, F2 and F3 together. It is occupied, undercut
by a trivial baseline, statistically infeasible at observed base rates, and
contradicted by the one large-scale deployment attempt.

The **robustness** thesis survives everything above, because it depends on none
of it:

> Acceptance criteria are a finite epistemic resource. An agent that can query
> a criterion repeatedly and adapt will exhaust its validity at a rate that can
> be measured, bounded, and slowed.

This needs no defect prediction, no outcome labels, no 0.33% base rate, and no
partner organization. It is measurable in simulation and in controlled agent
experiments, with ground truth the experimenter holds out and controls.

---

## 5. The agenda restated in standard terminology

Project-specific language mapped to the literature's.

| Genesis term | Standard term |
|---|---|
| Acceptance contract | Pre-registered evaluation protocol; held-out specification |
| Contract freezing | Pre-registration; commitment to an analysis plan |
| Evidence collection | Feature extraction with provenance |
| Adjudication | Selective classification under a decision-theoretic loss |
| `HUMAN_REVIEW` | Abstention / rejection option (Chow) |
| Mechanical failure is terminal | Lexicographic constraint ordering |
| Judgmental evidence | Weak/noisy labeling channel |
| The ledger | Longitudinal decision–outcome dataset |
| Outcome label | Delayed ground-truth response with verification latency |
| Calibration / backtest | Prequential evaluation under temporal splits |
| Contract gaming | Strategic manipulation (Hardt et al.); reward hacking |
| Gate degradation | Loss of holdout validity under adaptive querying |
| Pre-registration violated | Post-hoc specification; garden of forking paths |
| Evidence authored in diff | Endogeneity of the feature to the treatment |
| Genesis (system) | Performative predictor in a strategic classification game |

### 5.1 The restated research programme

**Primary question.** *Under what conditions, and at what rate, does a
pre-registered evaluation criterion lose validity when an optimizing agent can
query it adaptively — and which mechanisms preserve validity longest at what
cost to informativeness?*

**Formal setting.** A performative prediction problem (Perdomo et al.) in which
the decision rule induces distribution shift in submitted artifacts; equivalently
a strategic classification game (Hardt et al.) where manipulation cost is agent
inference cost. The validity-preservation question maps onto adaptive data
analysis (Dwork et al.): the criterion is a holdout, each agent iteration is an
adaptive query, and the bounds and DP-based mechanisms apply directly.

**Primary hypothesis (H*).** *Criterion validity — the correlation between
criterion satisfaction and held-out task success — decays monotonically in the
number of adaptive queries, at a rate increasing in feedback granularity; and
randomized-response or holdout-rotation mechanisms slow this decay at a
quantifiable cost in informativeness.*

**Secondary.** (a) Does pre-registration reduce the decay rate relative to
post-hoc criteria? (b) Does decay rate scale with agent capability, as
overoptimization scales with KL budget in 📚 Gao, Schulman & Hilton (2023)?
(c) Do the theoretical query bounds hold empirically for natural-language
criteria?

**Primary endpoint.** Criterion validity as a function of query count, with the
functional form estimated. **This is a scaling-law-shaped question**, and the
reward-model overoptimization paper is the methodological template.

**Why this is tractable where the prediction thesis is not.** Ground truth is
held out by the experimenter rather than waiting on production; the base rate is
whatever the experiment sets; no partner organization is needed; and every
outcome — fast decay, slow decay, no decay — is informative.

---

## 6. Reading list

Twenty-eight papers. Marked ★ where reading is a precondition for any stronger
claim, not merely useful.

**Adaptive data analysis — the new formal core**
1. ★ ✅ Dwork, Feldman, Hardt, Pitassi, Reingold & Roth. *Preserving Statistical Validity in Adaptive Data Analysis.* STOC 2015.
2. ★ ✅ Dwork et al. *The reusable holdout: Preserving validity in adaptive data analysis.* Science, 2015.
3. ★ 📚 Blum & Hardt. *The Ladder: A Reliable Leaderboard for Machine Learning Competitions.* ICML 2015.
4. 📚 Dwork, Feldman, Hardt, Pitassi, Reingold & Roth. *Generalization in Adaptive Data Analysis and Holdout Reuse.* NeurIPS 2015.

**Strategic classification and performativity**
5. ★ ✅ Hardt, Megiddo, Papadimitriou & Wootters. *Strategic Classification.* ITCS 2016.
6. ★ ✅ Perdomo, Zrnic, Mendler-Dünner & Hardt. *Performative Prediction.* ICML 2020.
7. 📚 Miller, Perdomo & Zrnic. *Outside the Echo Chamber: Optimizing the Performative Risk.* ICML 2021.
8. 📚 Manheim & Garrabrant. *Categorizing Variants of Goodhart's Law.* 2018.

**Evaluation gaming and overoptimization**
9. ★ 📚 Gao, Schulman & Hilton. *Scaling Laws for Reward Model Overoptimization.* ICML 2023.
10. ★ 🔍 Burnat & Davidson. *A Benchmark for Strategic Auditee Gaming Under Continuous Compliance Monitoring.* 2026. — nearest sibling; read before claiming novelty.
11. 📚 Skalse, Howe, Krasheninnikov & Krueger. *Defining and Characterizing Reward Hacking.* NeurIPS 2022.
12. 📚 Pan, Bhatia & Steinhardt. *The Effects of Reward Misspecification.* ICLR 2022.

**Agentic software engineering — the field that moved**
13. ★ 🔍 Li et al. *AIDev: Studying AI Coding Agents on GitHub.* MSR 2026.
14. ★ 🔍 *From Code Review to Code Critique: Intent, Drift, and Spotlight for AI-Generated Diffs at Scale.* Meta, 2026.
15. 🔍 *Where Do AI Coding Agents Fail? An Empirical Study of Failed Agentic Pull Requests.* 2026.
16. 🔍 *Human-Written vs. AI-Generated Code: A Large-Scale Study of Defects, Vulnerabilities, and Complexity.* 2026.

**Defect prediction — the discouraging prior**
17. ★ ✅ Zeng, Zhang, Zhang & Zhang. *Deep Just-in-Time Defect Prediction: How Far Are We?* ISSTA 2021.
18. ★ ✅ Lewis, Lin, Sadowski, Zhu, Ou & Whitehead. *Does Bug Prediction Support Human Developers?* ICSE 2013.
19. 📚 Kamei et al. *A Large-Scale Empirical Study of Just-in-Time Quality Assurance.* TSE 2013.
20. 📚 Zimmermann, Nagappan, Gall, Giger & Murphy. *Cross-project defect prediction.* ESEC/FSE 2009.
21. 📚 McIntosh & Kamei. *Are Fix-Inducing Changes a Moving Target?* TSE 2018.
22. 📚 Herbold et al. *Problems with SZZ and Features.* EMSE 2022.

**Decisions, selective labels, and net benefit**
23. ★ 📚 Lakkaraju, Kleinberg, Leskovec, Ludwig & Mullainathan. *The Selective Labels Problem.* KDD 2017.
24. 📚 Kleinberg, Lakkaraju, Leskovec, Ludwig & Mullainathan. *Human Decisions and Machine Predictions.* QJE 2018.
25. ★ 📚 Vickers & Elkin. *Decision curve analysis: a novel method for evaluating prediction models.* Med Decis Making, 2006.
26. 📚 Elkan. *The Foundations of Cost-Sensitive Learning.* IJCAI 2001.

**Uncertainty and abstention**
27. 📚 Chow. *On optimum recognition error and reject tradeoff.* IEEE Trans. Inf. Theory, 1970.
28. 📚 Kumar, Liang & Ma. *Verified Uncertainty Calibration.* NeurIPS 2019.

**Read first, in order:** 1, 5, 6, 9, 10, 13, 14, 17, 18. Those nine determine
whether anything below them is worth doing.

---

## 7. Verdict

**Narrow drastically. Do not abandon.**

### 7.1 What must be abandoned

The **acceptance-layer prediction thesis** — that Genesis can determine which
machine-authored changes are safe to merge — should be dropped as the primary
research claim. It fails on three independent grounds, any one of which would be
serious:

- A trivial baseline (lines added) matches sophisticated models (✅ F1).
- Production base rates near 0.33%, combined with known label noise, may make
  the question **statistically unresolvable at feasible study size** (F2).
- The one large-scale deployment of change-risk information to developers
  changed no behavior (✅ F3).

And its novelty claims have been overtaken: AIDev, ARCTIC and the 2026 agentic-PR
literature occupy most of what `01-AGENDA.md` called new.

`01-AGENDA.md` should be treated as **superseded**, not amended. It was written
from memory, before this review, and its central experiment (E2) is partly
already published.

### 7.2 What survives, and is better

> **Genesis is the empirical study of how evaluation criteria lose validity
> when an optimizing agent can query them adaptively — and of the mechanisms
> that preserve validity at bounded cost to informativeness.**

Software acceptance is the testbed, not the subject. It is a good testbed
because checks are executable, iteration is cheap, ground truth can be held out
by the experimenter, and the agents are real.

This is stronger than what it replaces on every axis that matters:

- **It has formal foundations.** Adaptive data analysis supplies bounds and
  mechanisms; strategic classification and performative prediction supply the
  game-theoretic frame. Genesis was previously reasoning from scratch about
  problems with existing theory.
- **It does not depend on H1.** No defect prediction, no outcome labels, no
  0.33% base rate, no partner organization.
- **Every outcome is publishable.** Fast decay, slow decay, or no decay are all
  informative. The prediction thesis had a null that ends the program.
- **It is cheap and fast.** Simulation plus controlled agent experiments;
  months, not years.
- **It generalizes beyond software.** The same question governs RSP-style
  evaluation gates, benchmark contamination, and any eval an optimizing system
  is repeatedly exposed to — which is a live problem for every frontier lab.

### 7.3 Is it still a meaningful contribution?

Yes, but a narrower one than either prior document claimed, and it must be
positioned honestly:

- The **phenomenon** is not new — Goodhart, reward hacking, benchmark
  overfitting, and 🔍 Burnat & Davidson's compliance-auditing benchmark all
  precede it.
- The **theory** is not new — Dwork et al. and Hardt et al. own it.
- What is new is the **instantiation**: software acceptance criteria, queried by
  real coding agents, with executable checks and experimenter-controlled ground
  truth, and the import of adaptive-data-analysis guarantees into a domain that
  has never used them.

That is a workshop paper's worth of novelty with a strong paper's worth of
execution available. It is honest, tractable, and durable — the question of how
long an evaluation survives contact with an optimizer only becomes more pressing
as optimizers improve, which is exactly the five-year test.

### 7.4 What this means for the code

`src/` was built for the prediction thesis and is now **instrumentation for the
robustness thesis**, which needs much less of it.

Newly central: `report.ts` — feedback granularity is the *independent variable*
in every experiment that matters, and Genesis's detailed remediation output is
the maximum-leakage condition. `contract/` supplies the criterion under test.

Newly irrelevant to the research: the ledger's hash chain, the calibration
metrics, the backtest harness, outcome labeling, and most of the collectors.
They are fine engineering serving a question that has been retired.

**Do not delete them yet** — the prediction thesis is retired as a *primary*
claim, not disproven, and F1/F2 could be revisited if the base-rate problem
turns out to be domain-specific. But no further engineering should go into them.

### 7.5 Immediate next step

Read the nine starred papers in §6. Then run the E5 experiment from
`01-AGENDA.md` — the adversarial gaming pilot — which was already the cheapest
and most novel item there and is now the *entire* programme rather than a
subordinate part of it. It needs no dataset, no partner, and no outcome labels;
it measures criterion validity decay as a function of query count and feedback
granularity, against ground truth the experimenter holds out.

If validity does not decay, the surviving thesis is false and Genesis should be
abandoned. That experiment is weeks of work and it is now the whole question.
