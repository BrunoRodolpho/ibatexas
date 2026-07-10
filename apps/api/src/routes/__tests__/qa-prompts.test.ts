// WS-B: qa-prompts ROUTE HANDLERS behind the qa-control gate.
//
// The "Prompts" workbench backend (registerPromptRoutes) is registered INSIDE
// qaControlRoutes, so it inherits the exact dev-only + timing-safe-Bearer gate
// the sibling qa-control routes have. This file pins: the bearer gate (401),
// dev-only registration (404 under production), the catalog list + item reads,
// the wired-prompt save, the 409 on a not-runtime-wired prompt, the 404 on an
// unknown id, invalid-body rejection, and the revert.
//
// The prompt catalog + the prompt_override store are both mocked, so no real DB
// is touched and the wired/not-wired axis is controlled by the fixture catalog.

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// 24-char dev token (>= 16 required by the gate). Not a secret. // gitleaks:allow
const TOKEN = "qa-ctl-secret-token-1234";
const AUTH = { authorization: `Bearer ${TOKEN}` };

// existsSync must return true for the repo-root probe (pnpm-workspace.yaml) and
// the ibx binary (gate) so qaControlGate() opens. Nothing else is FS-touched here.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: () => true };
});

// Fixture catalog: one WIRED prompt (editable) + one NOT-wired prompt (read-only,
// drives the 409). Controls the wired axis independent of the real catalog.
vi.mock("../../claustrum/prompts/prompt-catalog.js", () => {
  const CATALOG = [
    {
      id: "ibatexas/planner.persona",
      name: "Customer planner persona",
      stage: "planner",
      kind: "persona",
      path: "apps/api/src/claustrum/prompts/personas.ts (PLANNER_PERSONA)",
      wired: true,
      source: "DEFAULT PLANNER TEXT",
    },
    {
      id: "ibatexas/readonly.fragment",
      name: "Read-only fragment (not wired)",
      stage: "responder",
      kind: "fixed-reply",
      path: "apps/api/src/claustrum/prompts/personas.ts (NOT_WIRED)",
      wired: false,
      source: "DEFAULT READONLY TEXT",
    },
  ];
  const byId = new Map(CATALOG.map((e) => [e.id, e]));
  return { PROMPT_CATALOG: CATALOG, promptById: (id: string) => byId.get(id) };
});

// Mock the override store so no pg pool is created; the in-memory map mirrors it.
const overrides = vi.hoisted(() => ({ map: new Map<string, string>(), setThrows: false }));
vi.mock("../../claustrum/prompts/prompt-overrides.js", () => ({
  hasOverride: (id: string) => overrides.map.has(id),
  overrideText: (id: string) => overrides.map.get(id) ?? null,
  setPromptOverride: async (id: string, content: string) => {
    if (overrides.setThrows) throw new Error("db down");
    overrides.map.set(id, content);
  },
  deletePromptOverride: async (id: string) => {
    overrides.map.delete(id);
  },
}));

import { qaControlRoutes } from "../qa-control.js";

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(qaControlRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("IBX_QA_CONTROL_ENABLED", "true");
  vi.stubEnv("IBX_QA_CONTROL_TOKEN", TOKEN);
  overrides.map.clear();
  overrides.setThrows = false;
});

// ── gate: dev-only + bearer ───────────────────────────────────────────────────

describe("qa-prompts — gate", () => {
  it("does not register the prompt routes under production (404)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/prompts", headers: AUTH });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("401s a prompt request with no bearer", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/prompts" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "Unauthorized" });
    await app.close();
  });
});

// ── list + item reads ─────────────────────────────────────────────────────────

describe("qa-prompts — reads", () => {
  it("GET /prompts lists the catalog with editable + override state", async () => {
    overrides.map.set("ibatexas/planner.persona", "LIVE OVERRIDE");
    const app = await build();
    const res = await app.inject({ method: "GET", url: "/internal/qa/prompts", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompts).toEqual([
      {
        id: "ibatexas/planner.persona",
        name: "Customer planner persona",
        stage: "planner",
        kind: "persona",
        path: "apps/api/src/claustrum/prompts/personas.ts (PLANNER_PERSONA)",
        editable: true,
        hasOverride: true,
      },
      {
        id: "ibatexas/readonly.fragment",
        name: "Read-only fragment (not wired)",
        stage: "responder",
        kind: "fixed-reply",
        path: "apps/api/src/claustrum/prompts/personas.ts (NOT_WIRED)",
        editable: false,
        hasOverride: false,
      },
    ]);
    await app.close();
  });

  it("GET /prompts/* returns the default + effective text (override wins)", async () => {
    overrides.map.set("ibatexas/planner.persona", "LIVE OVERRIDE");
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/prompts/ibatexas/planner.persona",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toMatchObject({
      id: "ibatexas/planner.persona",
      editable: true,
      hasOverride: true,
      source: "DEFAULT PLANNER TEXT",
      effective: "LIVE OVERRIDE",
    });
    await app.close();
  });

  it("GET /prompts/* falls back to source when no override exists", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/prompts/ibatexas/planner.persona",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toMatchObject({ hasOverride: false, effective: "DEFAULT PLANNER TEXT" });
    await app.close();
  });

  it("GET /prompts/* 404s an unknown id", async () => {
    const app = await build();
    const res = await app.inject({
      method: "GET",
      url: "/internal/qa/prompts/no/such/prompt",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ── save / revert ─────────────────────────────────────────────────────────────

describe("qa-prompts — save + revert", () => {
  it("PUT a wired prompt persists the override", async () => {
    const app = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/internal/qa/prompts/ibatexas/planner.persona",
      headers: AUTH,
      payload: { text: "NEW PLANNER TEXT" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: "ibatexas/planner.persona", hasOverride: true });
    expect(overrides.map.get("ibatexas/planner.persona")).toBe("NEW PLANNER TEXT");
    await app.close();
  });

  it("PUT a NOT-runtime-wired prompt returns 409 (read-only)", async () => {
    const app = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/internal/qa/prompts/ibatexas/readonly.fragment",
      headers: AUTH,
      payload: { text: "attempt" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("not runtime-wired");
    expect(overrides.map.has("ibatexas/readonly.fragment")).toBe(false);
    await app.close();
  });

  it("PUT an unknown id returns 404", async () => {
    const app = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/internal/qa/prompts/no/such/prompt",
      headers: AUTH,
      payload: { text: "x" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("PUT an empty body is rejected with 400", async () => {
    const app = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/internal/qa/prompts/ibatexas/planner.persona",
      headers: AUTH,
      payload: { text: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid body");
    await app.close();
  });

  it("DELETE reverts a prompt to the compiled-in default", async () => {
    overrides.map.set("ibatexas/planner.persona", "LIVE OVERRIDE");
    const app = await build();
    const res = await app.inject({
      method: "DELETE",
      url: "/internal/qa/prompts/ibatexas/planner.persona",
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, id: "ibatexas/planner.persona", hasOverride: false });
    expect(overrides.map.has("ibatexas/planner.persona")).toBe(false);
    await app.close();
  });
});
