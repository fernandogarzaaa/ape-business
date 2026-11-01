# Meta Hackathon Submission — filled draft (DO NOT SUBMIT)

For Inan's review only. Nothing here has been submitted, uploaded,
or published. Deadline: Nov 5, 2026, 10:00 AM Manila.
Decisions still owned by Inan (see checklist at the bottom):
team/track wording, threshold confirmation, video, final go-ahead.

## Suggested one-paragraph description (verified claims only)

APE runs the agent. Before any tool call runs, a Sigil gate checks
that tool server's signed badge: trusted calls run, untrusted calls
are blocked, and both outcomes go to an audit trail. In the offline
demo, @apify/actors-mcp-server 0.17.1 (risk 100/low) is ALLOWed and
fixture-server 0.1.0 (0/critical, revoked — labeled test fixture,
not a real server) is DENIED. The gate policy is PROPOSED, not
confirmed: block high, critical, unknown, bad signature, and
revoked; allow low and medium. A badge proves identity, version,
and risk level only — not that an agent is good at its job.
Everything beyond the demo loop is test mode or dry run, $0 spent:
no live Stripe, AWS, or SMS is claimed, and no production Sealbox
vault is claimed. Reproduce in under two minutes, fully offline:
clone fernandogarzaaa/ape-business, `npm ci`, then
`node demo/sigil-gate-demo.mjs`.

## Evidence (literal, fresh clone of main @ c117d5e, 2026-11-01)

- Demo: allowed-tool ALLOW (@apify/actors-mcp-server 0.17.1,
  100/low); blocked-tool DENY (revoked) (fixture-server 0.1.0,
  0/critical).
- Sigil tests: 22 pass, 0 fail. Original suite: 190 pass, 0 fail.
  Locked eval suite: 3/3. Provisioning: SMS 15, email 10,
  Stripe 12, AWS dry-run allPass, production 16, e2e passed.
- Fresh-clone timing: clone ~3s, npm ci ~1s, demo <1s. No keys,
  no network beyond the clone/install, no spend.
- Muse Wonder 1.0 via the Meta Model API was verified in the demo
  copy before the move (79 tokens; wonder-in-loop allow/block
  recorded). Live-model quality on real business tasks: NOT
  measured. Say exactly that if asked.

## Video outline (not recorded; Inan records/approves)

1. (0:00) One sentence: "APE runs the agent; Sigil decides what
   it may touch." Show the README honest labels.
2. (0:20) Terminal: offline demo. ALLOW case runs.
3. (0:50) HERO: revoked fixture-server DENIED; audit line on screen.
4. (1:30) One real flow at test speed: onboarding -> verified test
   webhook -> ready receipt (labeled test mode on screen).
5. (2:20) Limits, stated out loud: policy proposed, fixture is a
   fixture, $0 spent, badge != competence. Close on the audit trail.

## Submission checklist (from META_SUBMISSION_DRAFT.md, updated)

- [ ] Gate threshold confirmed by Inan
- [ ] Problem statement / track chosen by Inan
- [x] Public GitHub repo: fernandogarzaaa/ape-business (merged:
      PRs #8, #9, #15, #19; main CI green; fresh-clone verified)
- [x] Wonder call inside the agent loop, tested (allow and block)
- [ ] 3-minute demo video (outline above)
- [x] Project description drafted from verified claims (above)
- [ ] Meta product fields, filled by Inan or on his approval
- [ ] Submit, only on Inan's explicit go-ahead
