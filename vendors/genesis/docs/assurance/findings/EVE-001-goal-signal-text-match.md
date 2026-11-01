# EVE-001: `goalAchieved` is decided by raw substring match, not action verification

**Subject:** experience-validation-engine (EVE), `src/engine/session.ts`
**Severity:** exploitable — analogous to Ray's `stdout_spoofing` class, applied to a
behavioral rather than code oracle
**Status:** confirmed, reproducible, deterministic. Not yet reported upstream —
that decision is the user's, not made here.

This is the audit `docs/research/05-COMPETITIVE-SCAN.md` §2 called the first
honest use of `src/assurance/`: *"EVE is itself an oracle whenever its score
gates anything… auditing EVE with Genesis is the first honest use of the
tool."* It did not use the `src/assurance/` probe machinery directly — EVE's
oracle does not fit the `(task, agent-submitted completion) → accept/reject`
shape that machinery assumes (see §5) — but it applies the same method: construct
inputs designed to satisfy the oracle without satisfying the underlying task,
and check whether the oracle notices.

---

## 1. The mechanism under test

`goalAchieved` — the field every downstream score, finding, and executive
summary treats as ground truth for "did the simulated user succeed" — is set
here, in full:

```ts
// src/engine/session.ts:339-351
const text = visibleText(percept).toLowerCase();
const goal = goals.root;
if (
  !goalAchieved &&
  goal.successSignals.length > 0 &&
  goal.successSignals.every((s) => text.includes(s.toLowerCase()))
) {
  goalAchieved = true;
  goal.status = "achieved";
  endReason = "goal-achieved";
  ...
}
```

`goal.successSignals` is empty by default and only populated when a caller
supplies `goalSuccessSignals` — via the `EveConfig` YAML, no bare CLI flag
exists for it. When supplied, satisfaction is **lowercase substring containment
of every signal against all currently visible text on the screen** — heading,
body copy, and interactive-element labels alike, with no distinction between
"the user read this" and "the user did this."

## 2. The hypothesis

If success is decided by text presence rather than by verified state change,
then a success-signal keyword that happens to match an *incidental* piece of
visible text — a button label, an app name, marketing copy — will satisfy the
oracle regardless of whether the user did anything resembling the actual task.

## 3. The experiment

Black-box only. No EVE source touched; three ordinary `eve run --config`
invocations against the built-in `DEMO_APP`, same seed, same goal, same
persona — the **only** variable is which word is declared as the success
signal. Configs are checked in alongside this document
(`exploit-label-only.yaml`, `exploit-appname.yaml`, `control-terminal-screen.yaml`).

Goal for all three: `"export your notes"`, persona `first-time-user`, seed `4711`.

| Signal | Rationale for the choice | Where it lives in `DEMO_APP` |
|---|---|---|
| `"notes"` | The most natural short-hand for "your notes" | The app's own name, "Acme Notes" — on the landing screen, before login |
| `"export"` | A literal substring of the stated goal — the single most natural choice an author would make | The dashboard's **button label** `"Export all"` (`src/browser/mock.ts` DEMO_APP, `dashboard` screen) |
| `"download"` | Control: the word appears **only** on the terminal screen the goal actually requires reaching | The export screen's button label `"Download .zip"` — nowhere else in the app |

## 4. Results

```
$ eve run mock: --config exploit-appname.yaml --out out-appname --quiet
Overall experience score : 80/100
Outcome                  : goal-achieved
Steps / simulated time   : 0 / 0.0 min

$ eve run mock: --config exploit-label-only.yaml --out out-label --quiet
Overall experience score : 76/100
Outcome                  : goal-achieved
Steps / simulated time   : 9 / 0.4 min

$ eve run mock: --config control-terminal-screen.yaml --out out-control --quiet
Overall experience score : 75/100
Outcome                  : goal-achieved
Steps / simulated time   : 12 / 0.5 min
```

### 4.1 `"notes"` — achieved at step 0, before any action

`report.json`: `usage.steps: 0`, zero recorded iterations. The persona's very
first perception of the landing screen — before a single click, before login,
before anything resembling "exporting" — satisfies the goal, because the app is
named "Acme Notes."

EVE's own generated executive summary, quoted verbatim, narrates this as a
successful session:

> *"A simulated 'first-time-user' spent 0.0 simulated minutes (0 interactions)
> with mock:. […] The experience was good (overall score 80/100) […] The
> operator achieved their goal."*

Confirmed deterministic: re-run byte-identical (`overallScore`, `goalAchieved`,
`usage.steps` all match exactly on a second invocation).

### 4.2 `"export"` vs. `"download"` — a controlled minimal pair

This is the sharper result, because the two trajectories are **identical
through step 8**:

```
step 0-8   landing → pricing → signup → [type × 3] → click "Create account"
```

That click navigates to the dashboard. From there the two runs diverge purely
because of which word was declared as success:

- **`"export"`**: the dashboard's own perception — which includes the visible
  button labeled *"Export all"* — satisfies the signal immediately.
  `usage.steps: 9` (the step that perceives the dashboard). The persona never
  clicks "Export all." Never reaches the export screen. Never sees "Download
  .zip." The task is not performed in any sense a human would recognize, and
  the session is scored 76/100 with "the operator achieved their goal."

- **`"download"`**: the dashboard does *not* satisfy this signal (the word
  appears nowhere on it). The persona continues — reads the dashboard, types
  into search, and at step 11 clicks (the trajectory and DEMO_APP's screen
  order indicate this is "Export all") — landing on the export screen, whose
  visible text ("Download .zip") finally satisfies the signal. `usage.steps: 12`.
  This is genuine completion: the persona reached the screen the goal
  requires.

Both signal choices are equally defensible, ordinary things an author would
write for a goal literally titled "export your notes" — arguably `"export"` is
the *more* natural choice, since it's a verbatim substring of the goal
description. One of the two natural choices is silently satisfied by a button
label; the other requires the user to actually get there. Nothing in EVE's
interface, its config schema, or its documentation signals which kind of word
is safe to use.

## 5. Why this didn't originally fit `src/assurance/`'s taxonomy or machinery

*(Historical — resolved. See §9.)* Two structural mismatches, recorded here
because they explain what the extension in §9 actually had to solve, rather
than an analogy it borrowed:

1. **Ray's taxonomy is scoped to RLVR verifiers**: `verifier(task, agent-
   submitted completion) → accept/reject`, over math/JSON/code. EVE's oracle
   takes no submitted completion at all — the "candidate" is the *environment*
   (an app spec) and a declared success condition; the "verifier" is EVE's own
   simulation engine acting on both. `defect_class: stdout_spoofing` is the
   closest existing analogy (trusting printed text as evidence) but it is an
   analogy, not the same mechanism, and forcing this into `DEFECT_CLASSES`
   would have misrepresented a citation to a paper that doesn't cover this
   case — so it wasn't; see the separate `behavioral-taxonomy.ts` in §9.
2. **`VerifierAdapter` assumes a `{task_file, completion_file} → verdict`
   subprocess contract.** EVE's actual interface is `{app, goal, success
   signals} → full session}`, and there is no separate "completion" to
   substitute — the exploit is encoded in the *choice of success-signal
   string*, not in a file handed to a grader.

## 6. What this finding does and does not establish

**Does establish:** for the one behavioral oracle Genesis's own evidence
pipeline already depends on (`src/evidence/behavioral/eve.ts`), a natural,
non-adversarial choice of `goalSuccessSignals` can be satisfied by incidental
text with zero relationship to task completion, including in zero steps. This
is a real, reproducible, deterministic defect in the mechanism, found by simply
doing what `src/assurance/`'s own control-probe discipline argues for: check
whether a "should fail" input is wrongly accepted.

**Does not establish:** that EVE's *default* usage (no `goalSuccessSignals`
configured — which is what `src/evidence/behavioral/eve.ts`'s `defaultCommand`
currently does; it never sets this field) is affected. Without configured
signals, this code path never fires, and `goalAchieved` falls back to other
session-ending logic. It also says nothing about EVE's scoring dimensions
(usability, accessibility, etc.), which are computed independently and were not
probed here.

## 7. Options — resolved

Three options were recorded rather than acted on unilaterally, since this
session's instruction was to work on Genesis, not to alter or file issues
against a sibling repository unasked:

1. File this as an issue against `experience-validation-engine`. **Not done.**
   Still the user's call, not made here.
2. Extend `src/assurance/` with a new `Probe` variant and a documented,
   honestly-named defect class for behavioral/simulation oracles. **Done —
   see §9.**
3. Move to the next unclaimed item, auditing the Prime Intellect Environments
   Hub. **Next**, per the user's explicit instruction (2, then 3).

## 8. Reproduction

```bash
cd experience-validation-engine && npm install && npm run build
eve run mock: --config docs/assurance/findings/exploit-appname.yaml \
  --out /tmp/out --quiet
# → 0 steps, goal-achieved, score 80/100
```

The three config files are checked in next to this document, unmodified from
what was actually run.

## 9. Formalized as machinery

This finding is now reproducible through `genesis audit` rather than only by
hand:

```bash
genesis audit --suite behavioral --oracle eve \
  --eve-bin "node /path/to/experience-validation-engine/bin/eve.js"
```

What resolved the two mismatches in §5:

- **`src/assurance/behavioral-taxonomy.ts`** — a second taxonomy table, kept
  fully separate from Ray's `taxonomy.ts`, with two classes named for what was
  actually found: `zero_interaction_success` (§4.1) and
  `incidental_label_match` (§4.2's `"export"` case). `findings.ts` merges both
  tables for descriptor lookup; neither table needs to know the other exists.
- **`src/assurance/eve-oracle-adapter.ts`** — `EveOracleAdapter`, driving EVE's
  actual `--config`/`--out` interface (the same one
  `src/evidence/behavioral/eve.ts` drives, for a different purpose). A new
  `Judge` interface, extracted from `VerifierAdapter` in `verifier.ts`, is what
  lets `runAudit`/`concludeAudit`/`report.ts`/the ledger serve both an
  RLVR-style subprocess verifier and a config-driven behavioral oracle without
  either implementation knowing the other exists.
- **`src/assurance/suites/behavioral.ts`** — the exact three probes from §3
  and §4, as data: `behavioral/zero-interaction` (§4.1), `behavioral/
  incidental-label` and `behavioral/control-genuine-completion` (§4.2's
  minimal pair). `validateSuite()` accepts it as diagnostic.

Tested at two tiers, matching the discipline the EVE-integration fix
established: mocked tests that always run in CI (`tests/assurance-
behavioral.test.ts`, "EveOracleAdapter — mocked" and "behavioral audit —
mocked end to end"), plus a live block that runs only when a sibling
`experience-validation-engine` checkout is present — `describe.skipIf`, not a
fake — and, when it runs, reproduces this finding through the formal machinery:
`VERDICT: EXPLOITABLE`, both classes flagged, the control probe genuinely
correct. Confirmed via the built CLI as well as the test suite:

```
$ genesis audit --suite behavioral --oracle eve --eve-bin "node .../bin/eve.js"
VERDICT: EXPLOITABLE
  [exploitable] incidental_label_match — Incidental label match
  [exploitable] zero_interaction_success — Zero-interaction success
exit 1
```

What is still true, unchanged: this only bounds the defect classes the suite
probes. It says nothing about EVE's scoring dimensions, and option 1 (filing
upstream) remains undone and remains the user's call.
