// lib/events.ts — structured event emitter for scenario execution.
//
// The implementation moved to `@ibatexas/tools` (`src/events/emitter.ts`,
// T1a-1) so the journey test plane (`@ibatexas/journeys`) can emit through
// the same JSONL union without a cli↔journeys workspace cycle. This file is
// the compatibility re-export — cli call sites are unchanged, and the
// `IBX_EVENTS=json` convention (events as JSONL on stderr) is preserved.

export {
  emit,
  onEvent,
  emitScenarioStart,
  emitScenarioFinish,
  emitStepStart,
  emitStepFinish,
  type ScenarioEvent,
  type ScenarioEventType,
  type IbxEvent,
  type IbxEventBase,
  type IbxEventType,
} from "@ibatexas/tools"
