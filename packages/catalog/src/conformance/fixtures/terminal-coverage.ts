// Conformance fixtures for the TERMINAL-COVERAGE pass (LE2-017).
//
// Five rule ids, five fixture catalogs. The two DIVERGENCE fixtures need two
// capabilities each — a divergence is a coverage statement over a Pack's whole
// capability set, which is exactly why it is a compiler pass rather than a
// stricter type. Both give their capabilities distinct `legacyNames`, since
// sharing the base's tool name across two kinds would (correctly) trip
// `ambiguous-legacy-name` and stop the fixture being single-purpose.
//
// Two fixtures declare `alsoEmits` a slot-dataflow rule. That is the
// fail-closed design showing through, not fixture slop: a chat capability with
// no refusal floor is BOTH a missing required slot (the authoring contract)
// and an uncovered terminal (the coverage contract), and the compiler runs
// every pass even after one rejects, so both are reported.

import { CHAT_BASE, conformanceTriggers, FIXTURE_PACK } from "./base.js"
import { fixtureCatalog, type ConformanceFixture } from "../types.js"

export const TERMINAL_COVERAGE_FIXTURES: readonly ConformanceFixture[] = [
  {
    name: "terminal-coverage.missing-refusal-terminal",
    targets: "terminal-coverage/missing-refusal-terminal",
    alsoEmits: ["slot-dataflow/missing-required-slot"],
    why:
      "a guard chain with no floor. Every path through the chain that reaches no " +
      "EXECUTE / CONFIRM / ESCALATE / DEFER falls through to the Pack's default " +
      "REFUSE — the terminal is reachable and the capability names no basis code " +
      "for it.",
    definitions: fixtureCatalog({
      kind: "conformance.terminal.no-floor",
      pack: FIXTURE_PACK,
      mutating: true,
      tier: "chat",
      surfaces: ["chat"],
      auth: "guest",
      legacyNames: ["conformance_tool"],
      description: "Capacidade de conformidade (fixture).",
      guardRefs: [{ phase: "business", name: "conformanceBusinessGuard" }],
    }),
  },
  {
    name: "terminal-coverage.refusal-terminal-without-chain",
    targets: "terminal-coverage/refusal-terminal-without-chain",
    alsoEmits: ["slot-dataflow/blank-required-slot"],
    why:
      "a floor with no chain. With no guards, no EXECUTE / CONFIRM / ESCALATE / " +
      "DEFER is reachable and REFUSE is the capability's only terminal — a dead " +
      "capability, not a conservative one.",
    definitions: fixtureCatalog({
      ...CHAT_BASE,
      kind: "conformance.terminal.no-chain",
      guardRefs: [],
    }),
  },
  {
    name: "terminal-coverage.unreachable-guard-phase",
    targets: "terminal-coverage/unreachable-guard-phase",
    why:
      'phase "taint" is a legal `GuardPhase` (the type system accepts it) that ' +
      "names a terminal source which cannot exist: a Pack's taint slot is a single " +
      "TaintPolicy value, not a Guard[] array. The one rejection in this pass the " +
      "type system provably cannot make.",
    definitions: fixtureCatalog({
      ...CHAT_BASE,
      kind: "conformance.terminal.taint-phase",
      guardRefs: [{ phase: "taint", name: "conformanceTaintGuard" }],
    }),
  },
  {
    name: "terminal-coverage.divergent-pack-refusal-terminal",
    targets: "terminal-coverage/divergent-pack-refusal-terminal",
    why:
      "two capabilities of one Pack declaring different refusal floors. A Pack has " +
      "exactly one PolicyBundle.default basis code, so at most one can be right — " +
      "and generate-refusal-codes.ts projects the wrong one. The guard chains are " +
      "identical so only the floor rule fires.",
    definitions: fixtureCatalog(
      {
        ...CHAT_BASE,
        kind: "conformance.terminal.floor-a",
        legacyNames: ["conformance_tool_floor_a"],
        refusalCode: "order.default.deny",
      },
      {
        ...CHAT_BASE,
        kind: "conformance.terminal.floor-b",
        // Its own phrasings: two capabilities sharing CHAT_BASE's would
        // also trip conversation-projection/cross-capability-trigger-collision
        // (LE2-033), which is not what this fixture is a witness for.
        conversationTriggers: conformanceTriggers("floor-b"),
        legacyNames: ["conformance_tool_floor_b"],
        refusalCode: "order.default.refuse",
      },
    ),
  },
  {
    name: "terminal-coverage.divergent-pack-guard-chain",
    targets: "terminal-coverage/divergent-pack-guard-chain",
    why:
      "two capabilities of one Pack declaring different guard chains. types.ts " +
      "fixes the chain as the owning Pack's FULL list in bundle order — pack-wide " +
      "by construction, never a per-kind subset — so a divergent chain describes a " +
      "set of reachable terminals the kernel will not produce. The floors are " +
      "identical so only the chain rule fires.",
    definitions: fixtureCatalog(
      {
        ...CHAT_BASE,
        kind: "conformance.terminal.chain-a",
        legacyNames: ["conformance_tool_chain_a"],
        guardRefs: [{ phase: "business", name: "conformanceBusinessGuard" }],
      },
      {
        ...CHAT_BASE,
        kind: "conformance.terminal.chain-b",
        // Its own phrasings: two capabilities sharing CHAT_BASE's would
        // also trip conversation-projection/cross-capability-trigger-collision
        // (LE2-033), which is not what this fixture is a witness for.
        conversationTriggers: conformanceTriggers("chain-b"),
        legacyNames: ["conformance_tool_chain_b"],
        guardRefs: [
          { phase: "auth", name: "conformanceAuthGuard" },
          { phase: "business", name: "conformanceBusinessGuard" },
        ],
      },
    ),
  },
]
