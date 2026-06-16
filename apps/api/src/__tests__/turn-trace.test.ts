/**
 * Phase B+C — content-addressed prompts + redacted turn_trace capture.
 *
 * Covers:
 *  - prompt-drift guard: a fragment's hash is a function of its content.
 *  - composer surfaces: the planner persona composes byte-identical to the
 *    recorded golden surface; the responder grounded surface pulls capability
 *    fragments.
 *  - content-addressing: manifestWithHashes maps id → id@hash (idempotent).
 *  - capture: planner + responder emit an LLMTrace (manifest = id@hash) per call.
 *  - redaction: the turn_trace writer scrubs planted PII out of the completion.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  CognitiveState,
  Completion,
  CompletionRequest,
  ExplainerPort,
  ModelProvider,
  Plan,
  TelemetryPort,
} from "@claustrum/core";
import type { Decision } from "@adjudicate/core";
import type { CapabilityPlanner } from "@adjudicate/core/llm";
import {
  PLANNER_SURFACE,
  RESPONDER_CONVERSATIONAL_SURFACE,
  RESPONDER_GROUNDED_SURFACE,
  createIbatexasPromptComposer,
  hashFragmentContent,
  ibatexasPromptFragments,
  manifestWithHashes,
} from "../claustrum/prompts/ibatexas-prompts.js";
import { PLANNER_PERSONA, RESPONDER_PERSONA_PTBR } from "../claustrum/prompts/personas.js";
import { createIbatexasPlanner } from "../claustrum/ibatexas-planner.js";
import { createIbatexasResponder } from "../claustrum/ibatexas-responder.js";
import { createTurnTraceWriter } from "../claustrum/turn-trace-writer.js";

const PROMPT_BUDGET = { maxTokens: 100_000 };

function mkState(text: string): CognitiveState {
  return {
    perception: { text, channel: "web", receivedAt: "2026-06-14T00:00:00.000Z" },
    memory: { recentActions: [], facts: [] },
    retrieval: { docs: [] },
    tenantId: "ibatexas",
    locale: "pt-BR",
    conversationId: "conv-1",
    turnId: "turn-1",
  } as unknown as CognitiveState;
}

function mockModel(toolCalls: Array<{ id: string; name: string; input: unknown }>, text = ""): {
  model: ModelProvider;
} {
  const model: ModelProvider = {
    complete: vi.fn(
      async (_req: CompletionRequest): Promise<Completion> => ({
        model: "mock",
        stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
        text,
        toolCalls,
        inputTokens: 9,
        outputTokens: 4,
      }),
    ),
    stream: () => {
      throw new Error("unused");
    },
    embed: async () => {
      throw new Error("unused");
    },
  };
  return { model };
}

function capPlanner(reads: string[], intents: string[]): CapabilityPlanner<unknown, unknown> {
  return { plan: () => ({ visibleReadTools: reads, allowedIntents: intents }) };
}

function recordingTelemetry(): { telemetry: TelemetryPort; traces: unknown[] } {
  const traces: unknown[] = [];
  const telemetry: TelemetryPort = {
    emitTurn: vi.fn(async () => {}),
    emitLLMTrace: vi.fn(async (t) => {
      traces.push(t);
    }),
    emitMemoryAccess: vi.fn(async () => {}),
  };
  return { telemetry, traces };
}

describe("prompt-drift guard (fragment hashes are content-addressed)", () => {
  it("a fragment's hash changes when its content text changes", () => {
    expect(hashFragmentContent("abc")).toBe(hashFragmentContent("abc"));
    expect(hashFragmentContent("abc")).not.toBe(hashFragmentContent("abc ")); // trailing space
    expect(hashFragmentContent(PLANNER_PERSONA)).not.toBe(
      hashFragmentContent(`${PLANNER_PERSONA}\nedit`),
    );
  });

  it("each registered fragment's hash equals the hash of its content", async () => {
    for (const fragment of ibatexasPromptFragments()) {
      const content = await fragment.content({
        cognition: mkState("x"),
        capabilities: [],
      });
      expect(fragment.hash).toBe(hashFragmentContent(content));
    }
  });
});

describe("composer surfaces", () => {
  it("planner persona composes byte-identical to the recorded golden surface", async () => {
    const { composer } = createIbatexasPromptComposer();
    const composed = await composer.compose(
      { cognition: mkState("x"), extra: { surface: PLANNER_SURFACE } },
      PROMPT_BUDGET,
    );
    expect(composed.system).toBe(PLANNER_PERSONA);
    expect(composed.fragmentManifest).toEqual(["ibatexas/planner.persona"]);
  });

  it("responder conversational surface composes to the bare persona", async () => {
    const { composer } = createIbatexasPromptComposer();
    const composed = await composer.compose(
      { cognition: mkState("oi"), extra: { surface: RESPONDER_CONVERSATIONAL_SURFACE } },
      PROMPT_BUDGET,
    );
    expect(composed.system).toBe(RESPONDER_PERSONA_PTBR);
  });

  it("responder grounded surface pulls the acted capability fragments", async () => {
    const { composer } = createIbatexasPromptComposer();
    const composed = await composer.compose(
      {
        cognition: mkState("cancela"),
        capabilities: ["order.cancel"],
        extra: { surface: RESPONDER_GROUNDED_SURFACE },
      },
      PROMPT_BUDGET,
    );
    expect(composed.fragmentManifest).toContain("ibatexas/responder.grounded");
    expect(composed.fragmentManifest).toContain("ibatexas/capability.order.cancel");
    // A capability NOT acted this turn is not pulled in.
    expect(composed.fragmentManifest).not.toContain("ibatexas/capability.reservation.create");
  });
});

describe("manifestWithHashes (content-addressing)", () => {
  it("maps bare ids to id@hash and is idempotent", () => {
    const { registry } = createIbatexasPromptComposer();
    const once = manifestWithHashes(registry, ["ibatexas/planner.persona"]);
    expect(once[0]).toMatch(/^ibatexas\/planner\.persona@[0-9a-f]{12}$/);
    const twice = manifestWithHashes(registry, once);
    expect(twice).toEqual(once); // already has @ → passthrough
  });
});

describe("LLM-trace capture", () => {
  it("the planner emits a trace with the id@hash manifest (no intentHash)", async () => {
    const { model } = mockModel([
      { id: "1", name: "express_intent", input: { capability: "order.item.add", payload: {} } },
    ]);
    const composer = createIbatexasPromptComposer();
    const { telemetry, traces } = recordingTelemetry();
    const planner = createIbatexasPlanner({
      model,
      modelId: "m",
      capabilityPlanners: [capPlanner([], ["order.item.add"])],
      promptComposer: composer,
      telemetry,
    });
    await planner.propose(mkState("quero adicionar costela"));
    expect(traces).toHaveLength(1);
    const t = traces[0] as { turnId: string; promptManifest: string[]; intentHash?: string };
    expect(t.turnId).toBe("turn-1");
    expect(t.promptManifest).toEqual([
      expect.stringMatching(/^ibatexas\/planner\.persona@[0-9a-f]{12}$/),
    ]);
    expect(t.intentHash).toBeUndefined();
  });

  it("the responder emits a grounded trace carrying the decision's intentHash", async () => {
    const { model } = mockModel([], "Cancelei seu pedido.");
    const composer = createIbatexasPromptComposer();
    const { telemetry, traces } = recordingTelemetry();
    const explainer: ExplainerPort = { render: () => "x" };
    const responder = createIbatexasResponder({
      model,
      modelId: "m",
      explainer,
      promptComposer: composer,
      telemetry,
    });
    const decision = { kind: "EXECUTE", basis: [] } as unknown as Decision;
    const plan = {
      envelopes: [{ kind: "order.cancel", intentHash: "deadbeef" }],
      capabilities: ["order.cancel"],
    } as unknown as Plan;
    await responder.respond({ cognition: mkState("cancela"), decision, plan, acted: { kind: "executed", envelope: { kind: "order.cancel" } } });
    expect(traces).toHaveLength(1);
    const t = traces[0] as { promptManifest: string[]; intentHash?: string };
    expect(t.intentHash).toBe("deadbeef");
    expect(t.promptManifest).toContain(
      manifestWithHashes(composer.registry, ["ibatexas/responder.grounded"])[0],
    );
  });
});

describe("turn_trace writer redaction", () => {
  function mockPool() {
    const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];
    return {
      queries,
      pool: {
        query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
          queries.push({ sql, params });
          return { rowCount: 1 };
        }),
      },
    };
  }

  it("scrubs planted PII (email/cpf) out of the completion", () => {
    const { pool } = mockPool();
    const writer = createTurnTraceWriter(pool, { redactSecret: "test-secret" });
    const scrubbed = writer.redactCompletion(
      "Confirmo o pedido de joao@example.com, CPF 123.456.789-00.",
    );
    expect(scrubbed).not.toContain("joao@example.com");
    expect(scrubbed).not.toContain("123.456.789-00");
    expect(scrubbed).toMatch(/REDACTED/i);
  });

  it("[F4] scrubs a Brazilian CEP (postal code) the base PII set misses", () => {
    const { pool } = mockPool();
    const writer = createTurnTraceWriter(pool, { redactSecret: "test-secret" });
    const scrubbed = writer.redactCompletion(
      "Entrega para a Rua das Flores, 100 — CEP 01310-100.",
    );
    expect(scrubbed).not.toContain("01310-100");
    expect(scrubbed).toContain("[REDACTED:cep]");
  });

  it("write() inserts a redacted completion and purgeOlderThan issues a DELETE", async () => {
    const { pool, queries } = mockPool();
    const writer = createTurnTraceWriter(pool, { redactSecret: "s" });
    await writer.write({
      turnId: "t1",
      callIndex: 0,
      conversationId: "c1",
      model: "m",
      temperature: 0,
      inputTokens: 1,
      outputTokens: 2,
      promptManifest: ["ibatexas/planner.persona@abc123abc123"],
      completion: "email leak: a@b.com",
      durationMs: 5,
      recordedAt: "2026-06-14T00:00:00.000Z",
    });
    const insert = queries.find((q) => q.sql.includes("INSERT INTO turn_trace"));
    expect(insert).toBeDefined();
    const completionParam = insert!.params?.[9] as string;
    expect(completionParam).not.toContain("a@b.com");

    const deleted = await writer.purgeOlderThan("2026-06-01T00:00:00.000Z");
    expect(deleted).toBe(1);
    expect(queries.some((q) => q.sql.includes("DELETE FROM turn_trace"))).toBe(true);
  });
});
