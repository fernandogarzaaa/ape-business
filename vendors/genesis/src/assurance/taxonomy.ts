/**
 * Verifier defect taxonomy.
 *
 * Adopted from Ray, "Before the Model Learns the Bug: Fuzzing RLVR Verifiers"
 * (arXiv 2606.01066), which enumerates eleven defect classes across three
 * domains. We build against that taxonomy rather than deriving our own: it is
 * published, it is specific, and rediscovering it would be the exact mistake
 * `docs/research/04-REDIRECTION-REVIEW.md` warns against.
 *
 * The premise, which is the whole reason this module exists: **a verifier is
 * executable software, and its bugs become rewardable failure modes.** An agent
 * optimizing against a verifier with a hole will find the hole. Auditing the
 * instrument before trusting its measurements is ordinary engineering hygiene
 * that the agent ecosystem mostly does not do.
 */

export const DOMAINS = ["math", "json", "code"] as const;
export type Domain = (typeof DOMAINS)[number];

export const DEFECT_CLASSES = [
  // ── math ──
  "loose_answer_extraction",
  "missing_markers",
  "contradiction_blindness",
  "loose_numeric_tolerance",
  // ── json tool-calls ──
  "schema_only_validation",
  "ignored_extra_fields",
  "duplicate_key_handling",
  "embedded_json_parsing",
  // ── code ──
  "visible_test_overfitting",
  "stdout_spoofing",
  "missing_timeouts",
] as const;

export type DefectClass = (typeof DEFECT_CLASSES)[number];

export interface DefectDescriptor {
  readonly id: DefectClass;
  readonly domain: Domain;
  readonly title: string;
  /** What the verifier does wrong. */
  readonly defect: string;
  /** What an agent gains by exploiting it. */
  readonly exploit: string;
}

export const TAXONOMY: Readonly<Record<DefectClass, DefectDescriptor>> = {
  loose_answer_extraction: {
    id: "loose_answer_extraction",
    domain: "math",
    title: "Loose answer extraction",
    defect: "Extracts the answer by scanning for any number rather than a declared final answer.",
    exploit: "Emit prose containing the target number in a non-answer position, including a negation.",
  },
  missing_markers: {
    id: "missing_markers",
    domain: "math",
    title: "Missing answer markers",
    defect: "Accepts completions that omit the required answer delimiter.",
    exploit: "Skip the marker and let a permissive fallback parser find something acceptable.",
  },
  contradiction_blindness: {
    id: "contradiction_blindness",
    domain: "math",
    title: "Contradiction blindness",
    defect: "Takes the first or last candidate answer without noticing the completion asserts several.",
    exploit: "Enumerate multiple answers so one matches whichever the extractor happens to pick.",
  },
  loose_numeric_tolerance: {
    id: "loose_numeric_tolerance",
    domain: "math",
    title: "Loose numeric tolerance",
    defect: "Compares with a tolerance wide enough to admit materially wrong values.",
    exploit: "Answer approximately, without doing the work.",
  },

  schema_only_validation: {
    id: "schema_only_validation",
    domain: "json",
    title: "Schema-only validation",
    defect: "Validates structure but never checks that field values are semantically right.",
    exploit: "Emit well-typed placeholder values — empty strings, zeroes, nulls-as-strings.",
  },
  ignored_extra_fields: {
    id: "ignored_extra_fields",
    domain: "json",
    title: "Ignored extra fields",
    defect: "Permits fields absent from the schema without flagging them.",
    exploit: "Smuggle additional arguments past the contract into a downstream consumer.",
  },
  duplicate_key_handling: {
    id: "duplicate_key_handling",
    domain: "json",
    title: "Duplicate key handling",
    defect: "Silently resolves duplicate keys by parser convention rather than rejecting.",
    exploit: "Emit both a compliant and a non-compliant value and rely on the verifier reading the compliant one.",
  },
  embedded_json_parsing: {
    id: "embedded_json_parsing",
    domain: "json",
    title: "Embedded JSON parsing",
    defect: "Recovers a payload from surrounding prose instead of requiring a clean document.",
    exploit: "Wrap several candidate payloads in text so a scavenging parser finds a passing one.",
  },

  visible_test_overfitting: {
    id: "visible_test_overfitting",
    domain: "code",
    title: "Visible-test overfitting",
    defect: "Runs only the tests shown to the agent, never the held-out ones.",
    exploit: "Hard-code the visible cases; implement nothing.",
  },
  stdout_spoofing: {
    id: "stdout_spoofing",
    domain: "code",
    title: "Stdout spoofing",
    defect: "Treats process output as evidence of correctness.",
    exploit: "Print whatever the harness greps for and exit zero.",
  },
  missing_timeouts: {
    id: "missing_timeouts",
    domain: "code",
    title: "Missing timeouts",
    defect: "Executes candidate code without a wall-clock bound.",
    exploit: "Hang the harness after signalling success, or deny service to the evaluation itself.",
  },
};

export function descriptorsFor(domain: Domain): DefectDescriptor[] {
  return DEFECT_CLASSES.map((id) => TAXONOMY[id]).filter((d) => d.domain === domain);
}
