# Competitive Scan, and the Unicorn Question

Three questions: is this unexplored, how does it differ from EVE, and who else is
in the space.

**Short answers: no, meaningfully but less than you'd hope, and a lot of people.**
The useful part is §5, which argues the question has been wrong for four rounds.

> Provenance: ✅ verified by search this session · 🔍 title/abstract only.

---

## 1. Is this a unicorn?

No. And this is the fourth consecutive round in which the answer has been no,
which is itself the most important data point in this document.

The assurance module's exact question — *do RL training environments and
verifiers contain exploitable defects, and can they be found automatically* — has
a published answer with numbers better than anything Genesis has produced:

🔍 **"Auditing Reward Hackability in Code RL Training Environments"
(arXiv 2606.16062)**, on a 49-task sample of SWE-bench Verified:

- **28.5% of tasks** have test suites weak enough that a Docker-verified
  *incorrect* patch passes them.
- Model Pass@1 is **+14.14 percentage points higher** on flagged-hackable tasks
  than on robust ones — the downstream harm, quantified.
- An inline LLM judge with a gold-sanity gate flags 65 of 105 decisive
  LLM-generated tests as failing on the gold patch itself: a **61.9%
  per-augmentation defect rate**.

That paper does what `src/assurance/` does, on real benchmarks, with effect sizes
on the training signal. Genesis's contribution next to it is a CLI and a ledger.

🔍 **Prime Intellect publishes on this directly** — a blog post titled
*"Systematic Reward Hacking and Prime Sprints"* — for the Environments Hub they
operate. The largest open RL environment platform treats this as an internal
priority, not an unmet need.

✅ **The commercial position is being bought, not invented.** Handshake acquired
**Cleanlab** in early 2026 — a quality-verification and error-detection startup —
explicitly to move "one rung up the value chain from labeling into evaluation and
quality assurance." The incumbents are integrating QA rather than leaving it open.

✅ **Meta-evaluation already ships.** Galileo sells LLM-judge consistency and bias
detection, with "a calibration step identifying where automated judges are
unreliable and need human override." That is evaluating the evaluator, in a
product, today.

So: the idea is not unexplored, the research is ahead of us, the platform owner is
on it, and the commercial slot is being consolidated.

---

## 2. Genesis assurance vs. EVE

The question is sharper than it looks, because the honest answer is that **you
have now built the same machine twice.**

|  | EVE | Genesis assurance |
|---|---|---|
| **Subject** | A running web application | A verifier / grader / harness |
| **Probe** | A simulated human operator — cognition, emotion, memory, a breaking point | Adversarial completions drawn from a defect taxonomy |
| **Ground truth** | None; the experience *is* the finding | The probe declares what a correct verifier must do |
| **Output** | Experience findings, scores, a narrative | Defect findings by class, with false-accept/false-reject rates |
| **Buyer** | Someone shipping a UI | Someone training or evaluating agents |
| **Thesis** | "Code correctness ≠ good software" | "The grader is software and has bugs" |

Genuinely different subjects and different buyers. But architecturally they are
the same system: *fire synthetic inputs at a target, score the responses, emit
structured findings with evidence.* EVE's probes are richer and its subject is
harder; Genesis's probes carry an expected answer, which EVE's cannot.

Two things follow.

**The unflattering one.** Building the same architecture twice is either a
platform insight or duplicated effort, and the difference is whether you ever
unify them. Right now they are two codebases, two CLIs, two finding schemas, two
report renderers. If the pattern is real, there is one probe-and-report engine
underneath with pluggable probes and subjects — and neither repo is that engine.

**The interesting one.** *EVE is itself an oracle whenever its score gates
anything.* If a team uses "EVE overall score ≥ 70" as an acceptance criterion,
EVE is a verifier and inherits every defect class in the taxonomy. Is EVE's
scoring gameable? Is its extraction loose? Does the same seed always produce the
same verdict under a slightly perturbed app?

**That is the first honest use of the assurance tool: audit your own verifier.**
It costs a day, it is a real finding either way, and it is the only test in this
document you can run without asking anyone's permission.

---

## 3. The market map

The RL environment market is large, real, and consolidating fast.

**Buyers:** frontier labs. **Concentration:** ✅ over 75% of AI training-data and
RL-environment revenue flows to four vendors — **Scale, Surge, Mercor,
Handshake**. ✅ Roughly 20 seed-to-Series-A companies are expected to resolve into
three to five leaders by 2030.

| Layer | Players | Bearing on Genesis |
|---|---|---|
| **Env production (incumbent)** | Scale, Surge (EnterpriseBench), Mercor (acquired Sepal AI, Deeptune), Handshake (acquired Cleanlab) | Buying QA rather than needing it |
| **Env production (pure-play)** | Mechanize, AfterQuery, Bespoke Labs, Huzzle Labs, Fleet AI, Datacurve | Potential customers — they must prove quality to labs |
| **Open platform** | **Prime Intellect** — Environments Hub, 2,500+ community environments, `verifiers` library, prime-rl, INTELLECT-3 | Largest public corpus; already publishing on reward hacking |
| **Eval observability** | Braintrust, LangSmith, Galileo, Humanloop, Patronus, Giskard, Confident AI | Crowded; Galileo already does judge calibration |
| **Research** | arXiv 2606.16062, 2606.01066, 2605.26079, 2604.15149 | Ahead of this repo |

One suggestive data point: an industry review titled ✅ *"RL Environment
Platforms: Not One Buyable Product Yet."* The market is enormous and the *tooling*
layer is immature even where the research is not. That gap is real — but it is a
gap in productization, which is won by distribution and support, not by ideas.

---

## 4. The one reframe worth considering

Everything above kills novelty. This is the single argument that survives it, and
it is commercial rather than intellectual.

**Labs buy environments from vendors. Who checks what they bought?**

The neutrality principle Genesis has carried since day one was always
epistemically weak — `03-CONVERGENCE.md` §3.4 records that self-review works fine
at Meta, so "the executor cannot grade itself" is not a law of nature.

But in a procurement relationship it is not an epistemic claim at all. It is an
**incentive** claim, and there it is strong: a vendor paid per delivered
environment cannot credibly certify the quality of its own deliverable. That is
precisely why financial audit exists — not because companies cannot count, but
because the incentive is wrong.

That gives the "audit infrastructure" framing something it has never had: **a
buyer with a reason to pay a third party.** A lab spending eight figures on RL
environments has an obvious interest in independent verification that 28.5% of
them are not hackable.

Honest caveats, and they are severe:

- This is a **certification and services business**, not a research programme and
  not really a software product.
- ✅ Handshake/Cleanlab shows incumbents are absorbing exactly this function.
- Third-party certification requires trust and a brand, which is a years-long
  build and is not helped by a better CLI.
- It may simply be that labs run their own audits, because they can.

I am not confident in this. I am confident it is the strongest remaining
framing, and that it is worth one week of talking to people rather than one month
of building.

---

## 5. The advice, which is about the question rather than the answer

Four rounds now: the acceptance layer, the prediction thesis, the robustness
thesis, and environment assurance. Each was retired by under an hour of search.
The pattern is not bad luck.

**"Something that does not exist yet" is close to an empty set in a field where
thousands of researchers publish weekly.** Anything you can think of in an
afternoon, someone with more context has thought of, and probably published.
Optimizing for unexplored ideas in a crowded field selects for ideas that are
unexplored *because they don't work*.

Novelty and value are different axes, and this project has spent five sessions
optimizing the first while never testing the second. Not once has anyone outside
this repository been asked whether they want any of it.

The things that were durably valuable in this session were never novel:

- The v1 kernel did not compile, because `typecheck` was scoped to the wrong
  directory and there was no CI. Mundane; the most valuable finding in the audit.
- Environment defects run 28–68%. Known; the strongest argument for the
  redirection.
- Control probes are mandatory or the audit is meaningless. Obvious in
  retrospect; the design decision that makes the tool work.

**Stop asking "has anyone done this." Start asking "who is in pain, and will they
pay."** Those have different answers, and only the second has ever built anything.

### What I would actually do, in order

1. **Audit EVE with Genesis.** One day. Your own verifier, your own repo, no
   permission needed. Either you find real defects — in which case the tool works
   and you have a story — or you don't, and you have learned something about both
   projects.

2. **Audit the Prime Intellect Environments Hub.** 2,500+ public environments, a
   platform that publicly acknowledges reward hacking, and published defect rates
   of 28–62% in comparable corpora. If those rates hold, a weekend produces a
   public report naming hundreds of broken environments. That is simultaneously a
   demo, a distribution channel, and customer discovery — and it costs nothing but
   compute.

3. **Then, and only then, talk to the pure-play vendors** — Mechanize, AfterQuery,
   Bespoke Labs, Fleet AI, Datacurve. They must prove environment quality to labs
   and lack the incumbents' in-house QA. Ask whether they would pay for
   independent certification. If three say no, the §4 reframe is dead and you have
   spent a week instead of a year.

Note what none of these are: building. The tool is built. **It has never been
pointed at anything that wasn't a fixture.**

---

## 6. Direct answers

**Is this a unicorn?** No. Every framing has prior art, the strongest paper in the
space has better numbers, and the commercial slot is being consolidated by
acquisition.

**Is it an evaluation project?** Yes — one level up. EVE evaluates software for
humans; this evaluates the evaluators of agents. Different subject, different
buyer, same architecture built twice.

**Should you keep going?** Only against a person, not against a literature. The
tool works, it is well-tested, and it has never met a real harness. That, not
novelty, is the missing thing.
