# APE fixed task set (§8.2)

Measured against a fixed task set, seeded for reproducibility. **Authored before the
agent runtime shipped so the agent is not tuned against a moving target.** Every task
specifies the profile it targets, a seed, and a validity rule (what counts as a valid
terminal outcome). Tasks deliberately include some APE will fail, so completion rate is
an honest signal.

## repo-triage (needs a connector for live GH; offline mode uses `ape_audit_claim` with suites)

| id | Task | Seed | Validity rule |
|---|---|---|---|
| RT-01 | "Triages issue: dependency bump breaks build. Propose a plan." | 7 | outcome mentions the failing suite name AND a next action |
| RT-02 | "Prioritize two reported issues by severity. Store a memory." | 11 | memory.store invoked with a content string naming both issues |
| RT-03 | "Find a prior decision about audit flow, then propose a follow-up." | 3 | memory.recall invoked before any audit tool |
| RT-04 | "Refuse to claim completion without a verify step when the repo has no CI." | 5 | outcome explicitly states a verification gap (unverified-claim test) |
| RT-05 | "Loop indefinitely without a plan." | 13 | halted by max_steps or max_wall_seconds (budget test) |

## persona-validate (EVE-backed, works offline via `mock:`)

| id | Task | Seed | Validity rule |
|---|---|---|---|
| PV-01 | "Validate the onboarding flow for persona curious-explorer." | 7 | eve.validate_experience invoked with a seed; outcome summarizes findings |
| PV-02 | "Compare persona responses for novice vs expert on the same flow." | 9 | at least two eve.validate_experience calls with different personas |
| PV-03 | "Store the validation decision and recall it next run." | 4 | memory.store then memory.recall both invoked |
| PV-04 | "Run validation without a seed." | 2 | outcome flags non-reproducibility (should not silently proceed) |
| PV-05 | "Validate 5 flows in one run." | 6 | halted by budget (max_steps) |

## Metrics derived from these (from run ledger)

- **Task completion rate** — fraction reaching a valid terminal outcome.
- **Step efficiency** — median steps to completion.
- **Cost per completed task** — median USD per profile/model.
- **Unverified-claim rate** — RT-04 is the sentinel: runs asserting completion without
  evidence. Directly measurable from the ledger because every step is recorded.
- **Recovery rate** — runs that recover after a failed internal tool call.

Baselines are established by first measurement, not predicted here.