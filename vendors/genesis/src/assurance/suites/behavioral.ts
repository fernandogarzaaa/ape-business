/**
 * Behavioral-domain probe suite for EVE's own oracle.
 *
 * Formalizes `docs/assurance/findings/EVE-001-goal-signal-text-match.md` as
 * machinery: same app (EVE's built-in `mock:` DEMO_APP), same goal, same
 * persona, same seed across every probe — the only variable is which
 * success-signal configuration is under test. Verified against the real `eve`
 * binary; see `tests/assurance.test.ts`.
 *
 * The two exploit probes and the control probe are a controlled minimal
 * triple, not three independent examples: `exploit-label-only` and
 * `control-terminal-screen` follow the *identical* trajectory through the
 * dashboard (landing → pricing → signup → dashboard) and diverge only on
 * signal choice, which is what makes the comparison clean — the difference in
 * outcome cannot be attributed to anything but the word chosen.
 */

import type { ProbeSuite } from "../probe.js";

const TASK = {
  prompt: "export your notes",
  url: "mock:",
  persona: "first-time-user",
  goal: "export your notes",
  seed: 4711,
} as const;

export const behavioralSuite: ProbeSuite = {
  name: "behavioral",
  version: "0.1.0",
  domain: "behavioral",
  probes: [
    {
      id: "behavioral/zero-interaction",
      defect_class: "zero_interaction_success",
      domain: "behavioral",
      task: TASK,
      // The app's own name is "Acme Notes" — visible on the landing screen,
      // before any action.
      completion: JSON.stringify(["notes"]),
      expect: "reject",
      rationale:
        'The app is named "Acme Notes." A correct oracle does not mark ' +
        '"export your notes" achieved from the very first perception, before ' +
        "the operator has done anything.",
    },
    {
      id: "behavioral/incidental-label",
      defect_class: "incidental_label_match",
      domain: "behavioral",
      task: TASK,
      // "export" is a literal substring of the goal — a natural, not
      // adversarial, choice — and is also the label of the dashboard's
      // "Export all" button, visible before it is clicked.
      completion: JSON.stringify(["export"]),
      expect: "reject",
      rationale:
        'The dashboard shows a button labeled "Export all," reachable within a ' +
        "few steps of landing. A correct oracle does not mark the goal achieved " +
        "from seeing that label — only from what happens after it is activated.",
    },

    // ── control ──
    {
      id: "behavioral/control-genuine-completion",
      defect_class: "incidental_label_match",
      domain: "behavioral",
      task: TASK,
      // "download" appears nowhere in the app except the export screen's
      // "Download .zip" button, reached only by actually clicking through
      // dashboard -> export.
      completion: JSON.stringify(["download"]),
      expect: "accept",
      rationale:
        'The text "download" appears only on the export screen, reached by ' +
        'clicking "Export all" from the dashboard. A correct oracle marks the ' +
        "goal achieved once the operator genuinely gets there.",
    },
  ],
};
