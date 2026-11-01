# Note: the EVE adapter had never been run against real EVE

Recorded because it is an instance of exactly the failure `src/assurance/`
exists to catch, found in this project's own integration by finally doing the
thing every prior session recommended and deferred: pointing something at a
real target instead of a fixture.

## What was wrong

`src/evidence/behavioral/eve.ts` built the command

```
npx eve run <url> --json --seed <seed> ...
```

and parsed **stdout** for a `SessionResult`. Neither is true of the real EVE
CLI:

- `eve run` has no `--json` flag. Passing one is silently ignored by EVE's
  argument parser (it is not rejected — it is simply not a recognized option).
- `eve run` writes `report.json` into `--out` (default `.eve-output/`). Nothing
  machine-readable goes to stdout; stdout carries the human-readable summary
  banner.
- `eve --version` also does not exist. It exits 2 and prints the CLI's help
  text, which the adapter's `version()` would have recorded verbatim as
  `collector.version` in every evidence envelope.

Every test for this collector mocked `stdout` directly, so all 192 tests in the
prior state of the repository passed while the adapter had never successfully
parsed a real EVE run. The first live invocation would have failed with *"could
not parse an EVE SessionResult from the output (expected --json),"* which is
exactly the kind of message a human reads as "EVE is misbehaving" rather than
"the adapter was never exercised."

## Why this matters here specifically

Section 04 of the assurance docs and every research memo before it argued the
same thing from different angles: mocked interfaces do not substitute for
running the real thing, and the base rate of defects in unaudited integrations
is high. This adapter is a case in point, self-inflicted, discovered only when
`genesis verify` was finally pointed at EVE's own repository instead of a
`FakeRunner`.

## The fix

- `defaultCommand()` no longer emits `--json`; it passes `--out <scratch-dir>`
  instead, where `<scratch-dir>` is a directory this adapter creates with
  `mkdtempSync` and removes after reading.
- After the process exits, the adapter reads `<scratch-dir>/report.json` and
  parses it with the existing `parseSession()` (kept for its brace-scavenging
  and `result`-unwrapping tolerance, in case some future EVE surface embeds the
  session differently — real report.json is currently a clean top-level
  object, no wrapper).
- `version()` no longer shells out to a flag that does not exist. It reports
  `"unknown (eve has no --version flag)"` rather than silently recording
  whatever the help text happened to be.
- Tests were rewritten so the fake runner honors `--out` — writing
  `report.json` to the path it is given — rather than mocking stdout. This is
  the same shape of fix `findings.ts`'s purity test and the assurance module's
  control-probe requirement both make: a test that cannot fail against a wrong
  implementation is not testing anything.

## Verification against the real binary

Not just unit tests. `genesis verify` was run against `experience-validation-
engine`'s own git history with a frozen contract whose sole criterion targets
EVE's mock app:

```
$ genesis verify --contract eve-contract.json --repo ~/experience-validation-engine

  collecting eve (1 requirement(s))…
  eve: 1 record(s) in 13052ms

VERDICT: SHIP
  EXP-001  SATISFIED
```

And the failure path, with a criterion the mock app's fixed script does not
satisfy:

```
VERDICT: NOT READY
  EXP-002  ✗ eve · false == true is false
      artifact e8ccc7aeeda3138b
exit 1
```

Determinism was checked directly, independent of the acceptance layer: the
collector was invoked twice with seed 4711 against `mock:`, and both runs
produced `overall_score: 47`, `total_findings: 6`, byte-identical — confirming
the property `admissibility.ts` depends on ("behavioral evidence without a
recorded seed is not reproducible") actually holds for the adapter as shipped,
not merely as designed.

## What this does not prove

It proves the *integration* works against EVE's mock app. It says nothing about
whether EVE's judgments are themselves sound — that is precisely the open
question `docs/research/05-COMPETITIVE-SCAN.md` §2 raised: *EVE is itself an
oracle whenever its score gates anything*, and auditing it with
`src/assurance/` is still an unclaimed next step, not a completed one.
