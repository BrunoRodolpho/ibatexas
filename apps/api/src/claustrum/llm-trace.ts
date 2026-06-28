// C1 (capture) — emit a full LLMTrace after each planner/responder model call.
//
// claustrum's `handleTurn` is FROZEN and does NOT call `emitLLMTrace` — that is
// the planner/responder's job (claustrum CC-003 expects exactly this). After a
// model completion, the planner/responder build a bounded `LLMTrace` and emit it
// via the injected `TelemetryPort`. The ibatexas telemetry impl
// (claustrum-bootstrap.ts → fastifyTelemetry) buffers traces per `turnId` and
// flushes them to the redacted `turn_trace` store at `emitTurn` (which carries
// the conversationId the LLMTrace itself does not).
//
// The promptManifest is content-addressed (`id@hash`) via `manifestWithHashes`
// so an old trace pins the prompt VERSION, not just its identity.

import {
  boundLLMTrace,
  type FragmentRegistry,
  type LLMTrace,
  type TelemetryPort,
} from "@claustrum/core";
import { manifestWithHashes } from "./prompts/ibatexas-prompts.js";

export interface ModelCallTraceArgs {
  readonly telemetry: TelemetryPort | undefined;
  /** Owning registry — used to resolve id → hash for the manifest. */
  readonly registry: FragmentRegistry | undefined;
  readonly turnId: string;
  readonly model: string;
  /** Bare fragment IDs from `ComposedPrompt.fragmentManifest`. */
  readonly fragmentManifest: ReadonlyArray<string>;
  readonly completionText: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly at: string;
  /** Optional — present on responder calls (the decision it replies to),
   * typically absent on planner calls (no intent formed yet). */
  readonly intentHash?: string;
}

/**
 * Build a bounded LLMTrace and emit it. Best-effort + NON-THROWING: telemetry
 * must never break a turn (a failed/absent sink is swallowed).
 */
export async function emitModelCallTrace(args: ModelCallTraceArgs): Promise<void> {
  const { telemetry } = args;
  if (telemetry === undefined) return;
  try {
    const promptManifest =
      args.registry !== undefined
        ? manifestWithHashes(args.registry, args.fragmentManifest)
        : [...args.fragmentManifest];
    const trace: LLMTrace = boundLLMTrace({
      turnId: args.turnId,
      promptManifest,
      model: args.model,
      temperature: 0,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      completion: args.completionText,
      durationMs: args.durationMs,
      at: args.at,
      ...(args.intentHash !== undefined ? { intentHash: args.intentHash } : {}),
    });
    await telemetry.emitLLMTrace(trace);
  } catch {
    // Telemetry must never break a turn.
  }
}
