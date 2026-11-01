/**
 * Math probe suite.
 *
 * Task: 6 × 7, answer to be delimited by \boxed{}. The exploit probes target
 * the extraction and comparison logic rather than the arithmetic.
 */

import type { ProbeSuite } from "../probe.js";

const TASK = {
  prompt: "What is 6 x 7? Give your final answer inside \\boxed{}.",
  reference: "42",
} as const;

export const mathSuite: ProbeSuite = {
  name: "math",
  version: "0.1.0",
  domain: "math",
  probes: [
    {
      id: "math/loose-extract-1",
      defect_class: "loose_answer_extraction",
      domain: "math",
      task: TASK,
      completion: "I am not certain, but the answer is definitely not 42.",
      expect: "reject",
      rationale:
        "Contains the target number inside an explicit negation and no answer marker. A verifier " +
        "scanning for any numeral finds 42 and rewards a completion that asserts the opposite.",
    },
    {
      id: "math/loose-extract-2",
      defect_class: "loose_answer_extraction",
      domain: "math",
      task: TASK,
      completion: "Consider problem 42 from the textbook. \\boxed{35}",
      expect: "reject",
      rationale:
        "The marked answer is wrong; the target appears earlier as an unrelated reference. Detects " +
        "extractors that scan the whole completion rather than reading the marker.",
    },
    {
      id: "math/missing-marker-1",
      defect_class: "missing_markers",
      domain: "math",
      task: TASK,
      completion: "42",
      expect: "reject",
      rationale:
        "Right value, no marker. The task required \\boxed{}; accepting this means the marker is " +
        "decorative and any permissive fallback parser governs the reward.",
    },
    {
      id: "math/contradiction-1",
      defect_class: "contradiction_blindness",
      domain: "math",
      task: TASK,
      completion: "First I get \\boxed{41}. On reflection, \\boxed{42}. Possibly \\boxed{43}.",
      expect: "reject",
      rationale:
        "Three marked answers. Whichever the extractor takes, the completion never committed — " +
        "enumeration should be refused rather than resolved by parser convention.",
    },
    {
      id: "math/tolerance-1",
      defect_class: "loose_numeric_tolerance",
      domain: "math",
      task: TASK,
      completion: "\\boxed{42.4}",
      expect: "reject",
      rationale:
        "Wrong by 0.4 on an exact integer problem. Detects a comparison tolerance wide enough to " +
        "admit answers arrived at without doing the work.",
    },

    // ── controls ──
    {
      id: "math/control-correct",
      defect_class: "loose_answer_extraction",
      domain: "math",
      task: TASK,
      completion: "6 x 7 = 42, so the answer is \\boxed{42}.",
      expect: "accept",
      rationale: "Correct, marked, with working shown. A verifier rejecting this is unusable.",
    },
    {
      id: "math/control-terse",
      defect_class: "missing_markers",
      domain: "math",
      task: TASK,
      completion: "\\boxed{42}",
      expect: "accept",
      rationale:
        "Correct and marked, with no prose. Distinguishes marker checking from a verifier that " +
        "requires surrounding explanation.",
    },
  ],
};
