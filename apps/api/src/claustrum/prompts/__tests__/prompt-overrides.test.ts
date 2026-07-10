// Prompt override store unit tests — the seam behind the qa-viewer "Prompts"
// editor that executes on every production compose path (resolvePrompt). Pins:
//   - resolvePrompt returns the compiled-in constant when no override is loaded,
//     the override when one is present, and NEVER throws;
//   - loadPromptOverrides is fail-safe on a DB error (snapshot stays empty),
//     including the fail-safe-on-RELOAD case (a prior good load is cleared, not
//     left stale, when the next load fails);
//   - the PROD fail-closed governance gate (NODE_ENV=production without
//     ENABLE_PROMPT_OVERRIDES ⇒ rows SKIPPED, compiled-in constants unchanged);
//   - closePromptOverridePool() clears the snapshot + ends the pool on teardown.
// The `pg` Pool is mocked — no real DB is touched.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Per-test-controllable mock pg Pool. `queryImpl` lets each case decide what the
// store's SELECT/INSERT/DELETE resolves to (or throws).
const state = vi.hoisted(() => ({
  queryImpl: null as null | ((sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>),
  ended: 0,
}));

vi.mock("pg", () => {
  class Pool {
    on(): this {
      return this;
    }
    async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
      if (state.queryImpl) return state.queryImpl(sql, params);
      return { rows: [] };
    }
    async end(): Promise<void> {
      state.ended += 1;
    }
  }
  return { Pool };
});

import {
  resolvePrompt,
  loadPromptOverrides,
  setPromptOverride,
  deletePromptOverride,
  hasOverride,
  overrideText,
  overriddenIds,
  closePromptOverridePool,
} from "../prompt-overrides.js";

/** A queryImpl that returns `rows` for the load SELECT, `{ rows: [] }` else. */
function selectRows(rows: unknown[]): (sql: string) => Promise<{ rows: unknown[] }> {
  return async (sql: string) => (sql.includes("FROM prompt_override") ? { rows } : { rows: [] });
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  state.queryImpl = null;
  state.ended = 0;
  // Reset the module-singleton snapshot + pool between cases (clears snapshot).
  await closePromptOverridePool();
});

afterEach(async () => {
  await closePromptOverridePool();
});

describe("resolvePrompt", () => {
  it("returns the compiled-in constant when no override is loaded", () => {
    expect(resolvePrompt("ibatexas/planner.persona", "CONST TEXT")).toBe("CONST TEXT");
    expect(hasOverride("ibatexas/planner.persona")).toBe(false);
  });

  it("returns the override when the snapshot has one", async () => {
    state.queryImpl = selectRows([{ prompt_id: "ibatexas/planner.persona", content: "OVERRIDDEN" }]);
    await loadPromptOverrides();
    expect(resolvePrompt("ibatexas/planner.persona", "CONST TEXT")).toBe("OVERRIDDEN");
    expect(hasOverride("ibatexas/planner.persona")).toBe(true);
    expect(overrideText("ibatexas/planner.persona")).toBe("OVERRIDDEN");
    expect(overriddenIds()).toEqual(["ibatexas/planner.persona"]);
  });

  it("never throws (sync, safe on every compose) even for an unknown id", () => {
    expect(() => resolvePrompt("no/such.id", "FALLBACK")).not.toThrow();
    expect(resolvePrompt("no/such.id", "FALLBACK")).toBe("FALLBACK");
  });
});

describe("loadPromptOverrides — fail-safe", () => {
  it("leaves the snapshot empty and does NOT throw on a DB error", async () => {
    state.queryImpl = async () => {
      throw new Error("connection refused");
    };
    await expect(loadPromptOverrides()).resolves.toBeUndefined();
    expect(resolvePrompt("ibatexas/planner.persona", "CONST")).toBe("CONST");
    expect(overriddenIds()).toEqual([]);
  });

  it("clears a prior good load when a RELOAD fails (never leaves stale rows)", async () => {
    // First load succeeds and populates the snapshot.
    state.queryImpl = selectRows([{ prompt_id: "ibatexas/planner.persona", content: "V1" }]);
    await loadPromptOverrides();
    expect(resolvePrompt("ibatexas/planner.persona", "CONST")).toBe("V1");

    // The reload fails — the snapshot must be cleared, not left on V1.
    state.queryImpl = async () => {
      throw new Error("db went away");
    };
    await loadPromptOverrides();
    expect(resolvePrompt("ibatexas/planner.persona", "CONST")).toBe("CONST");
    expect(hasOverride("ibatexas/planner.persona")).toBe(false);
  });
});

describe("loadPromptOverrides — PROD fail-closed governance gate", () => {
  it("SKIPS overrides in production when ENABLE_PROMPT_OVERRIDES is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    state.queryImpl = selectRows([{ prompt_id: "ibatexas/planner.persona", content: "PROD OVERRIDE" }]);
    await loadPromptOverrides();
    // Fail-closed: the compiled-in constant is used unchanged.
    expect(resolvePrompt("ibatexas/planner.persona", "CONST")).toBe("CONST");
    expect(overriddenIds()).toEqual([]);
  });

  it("APPLIES overrides in production when ENABLE_PROMPT_OVERRIDES=true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_PROMPT_OVERRIDES", "true");
    state.queryImpl = selectRows([{ prompt_id: "ibatexas/planner.persona", content: "GOVERNED" }]);
    await loadPromptOverrides();
    expect(resolvePrompt("ibatexas/planner.persona", "CONST")).toBe("GOVERNED");
  });
});

describe("write path + teardown", () => {
  it("setPromptOverride refreshes the snapshot; deletePromptOverride reverts it", async () => {
    await setPromptOverride("ibatexas/planner.persona", "WRITTEN", "qa-viewer");
    expect(resolvePrompt("ibatexas/planner.persona", "CONST")).toBe("WRITTEN");
    await deletePromptOverride("ibatexas/planner.persona");
    expect(resolvePrompt("ibatexas/planner.persona", "CONST")).toBe("CONST");
  });

  it("closePromptOverridePool clears the snapshot and ends the pool", async () => {
    await setPromptOverride("ibatexas/planner.persona", "WRITTEN", "qa-viewer");
    expect(hasOverride("ibatexas/planner.persona")).toBe(true);
    await closePromptOverridePool();
    expect(hasOverride("ibatexas/planner.persona")).toBe(false);
    expect(overriddenIds()).toEqual([]);
    expect(state.ended).toBeGreaterThan(0);
  });
});
