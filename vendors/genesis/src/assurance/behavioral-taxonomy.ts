/**
 * Defect taxonomy for behavioral/simulation oracles — EVE's `goalAchieved` and
 * anything shaped like it.
 *
 * Deliberately kept separate from `taxonomy.ts`. That table is Ray's
 * published eleven classes for RLVR verifiers (arXiv 2606.01066); folding a
 * new class into it would misrepresent the citation. This table is this
 * project's own finding, recorded in full in
 * `docs/assurance/findings/EVE-001-goal-signal-text-match.md`, and it says so.
 *
 * The premise mirrors Ray's, one layer up: an RLVR verifier grades a
 * *submitted completion* against a task; a behavioral oracle like EVE grades
 * an *unfolding session* against a stated goal, using a decision rule that is
 * itself software and can itself have bugs. EVE's rule — a success signal is
 * satisfied by lowercase substring containment against all currently visible
 * screen text, with no distinction between text an operator merely saw and an
 * action an operator took — was found to accept sessions where nothing
 * resembling the goal was performed.
 */

export const BEHAVIORAL_DOMAINS = ["behavioral"] as const;
export type BehavioralDomain = (typeof BEHAVIORAL_DOMAINS)[number];

export const BEHAVIORAL_DEFECT_CLASSES = [
  "zero_interaction_success",
  "incidental_label_match",
] as const;

export type BehavioralDefectClass = (typeof BEHAVIORAL_DEFECT_CLASSES)[number];

export interface BehavioralDefectDescriptor {
  readonly id: BehavioralDefectClass;
  readonly domain: BehavioralDomain;
  readonly title: string;
  readonly defect: string;
  readonly exploit: string;
}

export const BEHAVIORAL_TAXONOMY: Readonly<
  Record<BehavioralDefectClass, BehavioralDefectDescriptor>
> = {
  zero_interaction_success: {
    id: "zero_interaction_success",
    domain: "behavioral",
    title: "Zero-interaction success",
    defect:
      "Marks the goal achieved from the very first perception, before the operator has taken a single action.",
    exploit:
      "Choose a success signal that matches incidental text already visible on the start screen — an app name, a tagline, a heading — so the oracle reports success with no task performed at all.",
  },
  incidental_label_match: {
    id: "incidental_label_match",
    domain: "behavioral",
    title: "Incidental label match",
    defect:
      "Marks the goal achieved because a success signal matches the visible LABEL of an interactive element the operator has not yet activated, rather than the outcome of activating it.",
    exploit:
      "Choose a success signal that is also the label of a button or link on the path to the goal — often a literal substring of the goal description, and so a natural rather than adversarial choice — so the oracle reports success on arrival at that screen, without the labeled action ever being taken.",
  },
};

export function behavioralDescriptorsFor(domain: BehavioralDomain): BehavioralDefectDescriptor[] {
  return BEHAVIORAL_DEFECT_CLASSES.map((id) => BEHAVIORAL_TAXONOMY[id]).filter(
    (d) => d.domain === domain,
  );
}
