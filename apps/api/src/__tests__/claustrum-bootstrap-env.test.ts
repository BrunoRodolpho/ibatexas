/**
 * bootstrapClaustrum fail-fast model env resolution.
 *
 * The old inline fallbacks named ids that do not exist at the Anthropic API
 * (a dated Opus id) or belong to another vendor entirely (an OpenAI embedding
 * id), so an unset env var surfaced as a 404 on the first conversational turn
 * instead of at boot. Boot must refuse, naming the missing variable, BEFORE
 * any infra (Postgres pool, Redis, audit sink) is touched — which is also
 * what lets this test run without mocks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapClaustrum } from "../claustrum-bootstrap.js";

const VARS = ["ANTHROPIC_MODEL", "EMBEDDING_MODEL_ID"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("bootstrapClaustrum model env fail-fast", () => {
  it("refuses boot without ANTHROPIC_MODEL, naming the variable", async () => {
    await expect(bootstrapClaustrum()).rejects.toThrow(
      "ANTHROPIC_MODEL env var is required",
    );
  });

  it("refuses boot without EMBEDDING_MODEL_ID, naming the variable", async () => {
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-6";
    await expect(bootstrapClaustrum()).rejects.toThrow(
      "EMBEDDING_MODEL_ID env var is required",
    );
  });
});
