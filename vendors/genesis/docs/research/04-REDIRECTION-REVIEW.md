# Review: Redirection to Agent Environment Assurance

Advisory review of Research Log 04.

**Verdict: adopt your own conclusion and drop the rest.** The log ends with
"Genesis ends as a product thesis. Genesis continues as infrastructure." That
sentence is correct. Everything above it — the new research question, H1–H5, the
six-week falsification plan — contradicts it and should be deleted.

The proposed research question has been asked and answered affirmatively by at
least three 2026 papers. Running the plan would rediscover published results.

---

## 1. The research question is already answered

> *Can automated oracle auditing detect environment defects before deployment?*

**Yes. Published, with taxonomies, metrics, and empirical results.**

🔍 **Ray, "Before the Model Learns the Bug: Fuzzing RLVR Verifiers"
(arXiv 2606.01066).** Read at summary depth. Fuzzes *the verifier itself* on the
premise that verifiers are executable software whose bugs become rewardable
failure modes. Eleven bug classes across three domains — math (loose answer
extraction, contradiction blindness, loose numeric tolerance), JSON tool-calls
(schema-only validation, ignored extra fields, duplicate keys), and code
(**visible-test overfitting, stdout spoofing, missing timeouts**). Explicitly
frames verifier reliability as *"a pre-training systems property that can be
measured and audited before optimization begins."*

That is the proposed research question, verbatim, including the pre-deployment
framing. Its metrics — false-positive rate, exploit-candidate rate,
reward-correctness gaps — are the metrics H1–H5 would have needed. Reported
findings: buggy math verifiers at 0.832 FPR, JSON tool-call verifiers at 0.869,
with optimization maintaining 0.967–1.000 reward against 0.15–0.17 true
correctness.

🔍 **"Auditing Reward Hackability in Code RL Training Environments"
(arXiv 2606.16062).** Auditing code RL environments for hackability. Same object,
same pre-deployment posture.

🔍 **"Automated Benchmark Auditing for AI Agents and Large Language Models"
(arXiv 2605.26079).** Auto Benchmark Audit — an agentic framework for systematic
issue detection in LLM benchmarks, producing *structured findings under a single
schema, each citing the file path it is drawn from.*

Note what that last one is: **the evidence envelope with provenance, already
built, for exactly this use case.** It is the item Research Log 04 lists under
"Preserved Assets" as a Genesis differentiator.

🔍 Also occupying the space: Harness-Bench (2605.27922) on harness effects across
models; ProofAgent Harness (2605.24134), open infrastructure for adversarial
agent evaluation; and UC Berkeley's trustworthy-env work, which broke eight major
agent benchmarks via 45 confirmed process-isolation exploits.

**This is a worse position than the thesis retired in `03-CONVERGENCE.md`.** That
one was adjacent to occupied territory. This one is the same question with
published affirmative answers.

---

## 2. The contradiction in the log

Two incompatible postures in one document:

> *Findings: idea novelty exhausted, artifact novelty remains.*
> *Conclusion: Genesis ends as a product thesis. Genesis continues as
> infrastructure.*

versus

> *New Research Question … Hypotheses H1–H5 … Experimental Plan: Weeks 1–6
> falsification … Kill Conditions.*

If idea novelty is exhausted, there is nothing to falsify — you build the
artifact and judge it on adoption. If you are running a six-week falsification
programme, you are claiming research novelty the same document disclaims two
lines earlier.

**The first posture is right.** §1 is the evidence. Delete the second.

H1–H5 and the kill conditions are unspecified placeholders in the log, so I
cannot review them on content. Given §1, specifying them would be wasted effort
rather than an omission to correct.

---

## 3. What the redirection got right

Two things, and one is genuinely important.

**The object of assurance moved from the artifact to the instrument.** Auditing
the environment rather than the change is the correct move, and it is precisely
what the prior thesis got wrong. Worth noting *why* it confers no advantage:
the move is correct because it is obvious, and several groups made it in the
same window.

**The base rates are the real argument, and the log does not make it.**

| Domain | Base rate of the thing being detected |
|---|---|
| Prediction thesis (retired) | **0.33%** production revert rate |
| Environment defects | **68.3%** of SWE-bench's 2,294 instances removed as invalid when building Verified |
| Environment defects | **59.4%** of audited failed problems had flawed tests, per OpenAI's internal audit on retiring SWE-bench Verified |

`03-CONVERGENCE.md` killed the prediction thesis substantially on base rate — at
0.33%, with SZZ label noise, the question is plausibly unresolvable at any
feasible study size. **Environment defects run two orders of magnitude more
common.** They are trivially measurable, need no outcome labels, no partner
organization, and no waiting on production.

That is a strong argument — for **building**, not for studying. When the defect
rate is 60%, you do not need a research programme to establish that defects
exist. You need a tool that finds them, and someone who wants it.

---

## 4. Does the artifact claim survive?

Partially, and it is the only thing that does.

**Against it:** ABA already implements structured, provenance-citing audit
findings. Berkeley's trustworthy-env already broke eight benchmarks. Ray's paper
already has the defect taxonomy.

**For it:** Ray's work reports no released tool or dataset — it is research code
with JSONL logging. Search indicates the ecosystem does not yet provide
production-mirrored environments for agent evaluation. There is a plausible gap
between *published method* and *usable infrastructure*, and Genesis's canonical
hashing, hash-chained ledger, evidence envelopes, and deterministic adjudication
are real, tested, and unusually disciplined for this space.

**But this is a tooling claim judged on tooling criteria** — does anyone install
it, does it beat running the research code, does it survive contact with a real
harness. This review contains no evidence about any of those, and no amount of
literature search will produce it. Only users will.

---

## 5. One correction to the log

> *25/25 hypothesis directions invalidated*

My ledger in `03-CONVERGENCE.md` §1 enumerates **fifteen** hypotheses across the
project, with named support and falsification for each. I cannot source the
other ten. Either work exists that I do not have, or the number is inflated.

In a research log this matters more than it seems: an unsourceable count is the
same species of error as an uncited citation, and this project has already been
burned once by a 758-line agenda written from memory whose central claims were
false. If the ten additional directions exist, they should be enumerated. If
they do not, the number should be fifteen.

---

## 6. Recommendation

**Adopt the log's conclusion. Drop the research framing entirely — this time
including the words "hypothesis," "falsification," and "kill condition."**

1. **Do not run the six-week plan.** It reproduces arXiv 2606.01066.
2. **Rename honestly.** "Agent Assurance Core" as *infrastructure*, with no
   research question attached. The preserved assets — canonical hashing, ledger,
   evidence envelopes, deterministic execution — are exactly right for that, and
   they are the reason to keep going.
3. **Read Ray's taxonomy and ABA first.** Eleven bug classes and a working audit
   schema are a specification handed to you for free. Build against them rather
   than rediscovering them; that alone converts weeks of "falsification" into a
   week of implementation.
4. **Find one user with one broken harness.** Given a ~60% environment defect
   rate, the first real harness you audit will produce findings within a day.
   That is the entire validation this direction needs, and it is not an
   experiment — it is a demo.

**The kill condition for the infrastructure direction is not empirical, it is
commercial:** if nobody will run the tool against their own harness, the artifact
claim fails, and nothing in the literature will tell you that either way.

---

## 7. What this project has actually produced

Worth stating plainly, three retirements in:

The prediction thesis died on base rate and prior art. The robustness thesis
died on Roelofs and the RLVR literature. The environment-assurance question is
answered in the affirmative by people who published first.

What survives is a working, well-tested implementation and **a documented map of
where not to go**, arrived at across a handful of sessions rather than a funding
cycle. That is a real output. It is not a research programme, and the third
attempt to make it one should be the last.

The recurring failure mode is now unmistakable: **each redirection has been
written before searching, and each has been retired by a search that took under
an hour.** The order should be reversed permanently. Search first; if the
question survives an hour of adversarial search, then write the log.
