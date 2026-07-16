// Prompt navigate + edit routes (dev-only) — the backend for the qa-viewer
// "Prompts" workbench. Lists every LLM-facing prompt (PROMPT_CATALOG), serves
// each one's compiled-in default + any live override, and writes/reverts
// overrides in the prompt_override store.
//
// DEV-ONLY + BEARER: registered INSIDE qaControlRoutes, after qaControlGate()'s
// early-return + the timing-safe Bearer preHandler, so they self-disable in
// production. (Prod prompt editing is a SEPARATE owner-authenticated admin
// route — Hard Rule #5 — not this dev surface.)
//
// Ids contain "/" (e.g. ibatexas/planner.persona), so the item routes use a
// wildcard param captured as request.params["*"].

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PROMPT_CATALOG, promptById } from "../claustrum/prompts/prompt-catalog.js";
import {
  deletePromptOverride,
  hasOverride,
  overrideText,
  setPromptOverride,
} from "../claustrum/prompts/prompt-overrides.js";
import { logger } from "../lib/logger.js";

const MAX_PROMPT_LEN = 20_000;

const PutBody = z.object({ text: z.string().min(1).max(MAX_PROMPT_LEN) }).strict();

/** Register the prompt navigate+edit routes. Call from inside qaControlRoutes. */
export function registerPromptRoutes(
  server: FastifyInstance,
  RL: { config: { rateLimit: { max: number; timeWindow: string } } },
): void {
  // ── list every prompt (catalog + override state) ──────────────────────────
  server.get("/internal/qa/prompts", RL, async () => ({
    prompts: PROMPT_CATALOG.map((e) => ({
      id: e.id,
      name: e.name,
      stage: e.stage,
      kind: e.kind,
      path: e.path,
      editable: e.wired,
      hasOverride: hasOverride(e.id),
    })),
  }));

  // ── one prompt: default + effective text ──────────────────────────────────
  server.get<{ Params: { "*": string } }>("/internal/qa/prompts/*", RL, async (request, reply) => {
    const id = request.params["*"];
    const entry = promptById(id);
    if (entry === undefined) return reply.code(404).send({ error: `unknown prompt: ${id}` });
    const override = overrideText(id);
    return {
      prompt: {
        id: entry.id,
        name: entry.name,
        stage: entry.stage,
        kind: entry.kind,
        path: entry.path,
        editable: entry.wired,
        hasOverride: override !== null,
        source: entry.source,
        effective: override ?? entry.source,
      },
    };
  });

  // ── save an override ──────────────────────────────────────────────────────
  server.put<{ Params: { "*": string } }>("/internal/qa/prompts/*", RL, async (request, reply) => {
    const id = request.params["*"];
    const entry = promptById(id);
    if (entry === undefined) return reply.code(404).send({ error: `unknown prompt: ${id}` });
    if (!entry.wired) {
      return reply.code(409).send({ error: `prompt "${id}" is not runtime-wired (read-only)` });
    }
    const parsed = PutBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid body", detail: parsed.error.issues });
    }
    const actor = typeof request.headers["x-qa-actor"] === "string" ? request.headers["x-qa-actor"] : "qa-viewer";
    try {
      await setPromptOverride(id, parsed.data.text, actor);
    } catch (err) {
      logger.error({ component: "qa-prompts", id, err: (err as Error).message }, "override write failed");
      return reply.code(500).send({ error: "override write failed" });
    }
    logger.warn({ component: "qa-prompts", id, actor }, "prompt override SET (dev)");
    return { ok: true, id, hasOverride: true };
  });

  // ── revert to the compiled-in default ─────────────────────────────────────
  server.delete<{ Params: { "*": string } }>("/internal/qa/prompts/*", RL, async (request, reply) => {
    const id = request.params["*"];
    const entry = promptById(id);
    if (entry === undefined) return reply.code(404).send({ error: `unknown prompt: ${id}` });
    try {
      await deletePromptOverride(id);
    } catch (err) {
      logger.error({ component: "qa-prompts", id, err: (err as Error).message }, "override delete failed");
      return reply.code(500).send({ error: "override delete failed" });
    }
    logger.warn({ component: "qa-prompts", id }, "prompt override REVERTED (dev)");
    return { ok: true, id, hasOverride: false };
  });
}
