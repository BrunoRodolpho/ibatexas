// Conformance fixtures for the CONVERSATION-PROJECTION pass (LE2-033).
//
// One fixture per rule id, each a `CHAT_BASE` with exactly one deviation —
// the corpus's standing discipline, and what makes the resulting diagnostics
// attributable to that deviation rather than to the fixture's shape.
//
// `CHAT_BASE.conversationTriggers` deliberately sits ON the floor (6
// phrasings), so the coverage fixture is a single `.slice()` away from the
// control rather than a hand-rebuilt array.
//
// Self-contained: nothing here reads the real `CAPABILITY_DEFINITIONS`, and
// every phrasing carries the word `conformance` so a fixture can never
// collide with an authored production phrasing.

import { CHAT_BASE, conformanceTriggers } from "./base.js"
import { fixtureCatalog, type ConformanceFixture } from "../types.js"

export const CONVERSATION_PROJECTION_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "conversation-projection.insufficient-trigger-coverage",
    targets: "conversation-projection/insufficient-trigger-coverage",
    why:
      "one phrasing below the floor. The base carries exactly " +
      "MIN_CONVERSATION_TRIGGERS, so dropping the last entry is the minimal " +
      "witness that the floor is enforced at the boundary and not one off it.",
    definitions: fixtureCatalog({
      ...CHAT_BASE,
      kind: "conformance.projection.thin",
      conversationTriggers: CHAT_BASE.conversationTriggers.slice(0, -1),
    }),
  },
  {
    name: "conversation-projection.malformed-trigger-phrasing",
    targets: "conversation-projection/malformed-trigger-phrasing",
    why:
      "a phrasing with a leading space and an internal double space. Both are " +
      "invisible in review and both survive into the embedded retrieval " +
      "document verbatim, which is why normal form is a build invariant.",
    definitions: fixtureCatalog({
      ...CHAT_BASE,
      kind: "conformance.projection.malformed",
      conversationTriggers: [
        ...CHAT_BASE.conversationTriggers.slice(0, -1),
        " conformance  gatilho malformado ",
      ],
    }),
  },
  {
    name: "conversation-projection.duplicate-trigger-phrasing",
    targets: "conversation-projection/duplicate-trigger-phrasing",
    why:
      "two phrasings in ONE capability that differ only by case, accent and " +
      "trailing punctuation. Deliberately NOT a byte-identical repeat: that " +
      "would also trip slot-dataflow/duplicate-slot-entry and stop being a " +
      "single-purpose witness for normal-form comparison.",
    definitions: fixtureCatalog({
      ...CHAT_BASE,
      kind: "conformance.projection.duplicate",
      conversationTriggers: [
        ...CHAT_BASE.conversationTriggers,
        // Entry [2] again, re-cased and re-punctuated.
        "Conformance Base Gatilho Três!",
      ],
    }),
  },
  {
    name: "conversation-projection.cross-capability-trigger-collision",
    targets: "conversation-projection/cross-capability-trigger-collision",
    why:
      "two capabilities claiming one phrasing — the rule the projection " +
      "exists for. Needs two objects by nature: a collision is not a property " +
      "any single capability has. The diagnostic lands on the LATER one and " +
      "names the earlier, so the pair is reconstructable from one line.",
    definitions: fixtureCatalog(
      { ...CHAT_BASE, kind: "conformance.projection.collision-first" },
      {
        ...CHAT_BASE,
        kind: "conformance.projection.collision-second",
        // A DISTINCT legacy name is load-bearing, not decoration: two
        // capabilities inheriting `CHAT_BASE.legacyNames` would also trip
        // referential-integrity/ambiguous-legacy-name, and the fixture would
        // stop being a single-purpose witness for the collision rule.
        legacyNames: ["conformance_tool_second"],
        conversationTriggers: [
          ...conformanceTriggers("collision-second").slice(0, -1),
          // The collision: byte-identical to the FIRST capability's entry [0].
          CHAT_BASE.conversationTriggers[0]!,
        ],
      },
    ),
  },
]
