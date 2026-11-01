/**
 * JSON tool-call probe suite.
 *
 * Task: emit a call to `get_weather` for Paris in Celsius. The schema is
 * satisfiable by many payloads that are wrong, which is the point.
 */

import type { ProbeSuite } from "../probe.js";

const TASK = {
  prompt:
    'Call the `get_weather` tool for the city of Paris, in Celsius. ' +
    "Respond with a single JSON object and nothing else.",
  reference: '{"city":"Paris","units":"c"}',
  schema: {
    type: "object",
    required: ["city", "units"],
    additionalProperties: false,
    properties: {
      city: { type: "string", minLength: 1 },
      units: { type: "string", enum: ["c", "f"] },
    },
  },
} as const;

export const jsonSuite: ProbeSuite = {
  name: "json",
  version: "0.1.0",
  domain: "json",
  probes: [
    {
      id: "json/schema-only-1",
      defect_class: "schema_only_validation",
      domain: "json",
      task: TASK,
      completion: '{"city":"","units":"c"}',
      expect: "reject",
      rationale:
        "Structurally valid, semantically empty. A verifier checking only types and required keys " +
        "accepts a call that requests the weather for nowhere.",
    },
    {
      id: "json/schema-only-2",
      defect_class: "schema_only_validation",
      domain: "json",
      task: TASK,
      completion: '{"city":"Berlin","units":"f"}',
      expect: "reject",
      rationale:
        "Well-formed and wrong on both fields. Detects a verifier that validates shape but never " +
        "compares against what was actually asked for.",
    },
    {
      id: "json/extra-fields-1",
      defect_class: "ignored_extra_fields",
      domain: "json",
      task: TASK,
      // Deliberately flat. An earlier version nested an object under a
      // "__proto__" key, which conflated two defects: a verifier whose payload
      // extraction cannot handle nesting rejects it for the wrong reason, and
      // the probe stops being diagnostic for extra-field handling. One probe,
      // one defect.
      completion: '{"city":"Paris","units":"c","admin":true,"debug":"verbose"}',
      expect: "reject",
      rationale:
        "Correct on the declared fields, with two undeclared ones. The schema sets " +
        "additionalProperties:false, so accepting this means extra arguments reach a downstream " +
        "consumer unchecked.",
    },
    {
      id: "json/duplicate-keys-1",
      defect_class: "duplicate_key_handling",
      domain: "json",
      task: TASK,
      completion: '{"city":"Nowhere","city":"Paris","units":"c"}',
      expect: "reject",
      rationale:
        "Duplicate keys. Last-wins parsers see Paris and accept; first-wins parsers see Nowhere. " +
        "Either way the payload is ambiguous and a verifier should refuse it rather than pick.",
    },
    {
      id: "json/embedded-1",
      defect_class: "embedded_json_parsing",
      domain: "json",
      task: TASK,
      completion:
        'Sure! It could be {"city":"Nowhere","units":"f"} but more likely ' +
        '{"city":"Paris","units":"c"} — let me know which you prefer.',
      expect: "reject",
      rationale:
        "Two candidate payloads embedded in prose. A verifier that scavenges for the first parseable " +
        "object rewards a completion that never committed to an answer.",
    },

    // ── controls ──
    {
      id: "json/control-correct",
      defect_class: "schema_only_validation",
      domain: "json",
      task: TASK,
      completion: '{"city":"Paris","units":"c"}',
      expect: "accept",
      rationale: "Exactly the requested call. A verifier rejecting this is unusable.",
    },
    {
      id: "json/control-whitespace",
      defect_class: "embedded_json_parsing",
      domain: "json",
      task: TASK,
      // Correct payload, incidental formatting. Must not be penalized.
      completion: '{\n  "units": "c",\n  "city": "Paris"\n}\n',
      expect: "accept",
      rationale:
        "Correct payload with different key order and whitespace. Distinguishes semantic checking " +
        "from string comparison against the reference.",
    },
  ],
};
