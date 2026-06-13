// T2-6b acceptance (negative path, zero infra) — the content key INCLUDES the
// system prompt and the tool surface, so a planner-prompt change breaks a
// fixture BY CONSTRUCTION:
//
//   "test this by asserting the fixture key derivation includes the system
//    prompt (a temporary one-char prompt mutation in a unit test must produce
//    a different content key / loud unknown-key error)" — plan v2 T2-6b.
//
// These tests run against the COMMITTED completion fixtures (the recorded
// planner/responder surfaces), with no containers — they execute on every PR
// in milliseconds even when the scripted-pipeline container suite is skipped
// locally via IBX_SKIP_REAL_*.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CompletionRequest } from "@claustrum/core";
import {
  canonicalizeRequestContent,
  createScriptedModelProvider,
  deriveContentKey,
  type ScriptedEntry,
} from "../helpers/scripted-model-provider.js";
import { loadScriptedEntries } from "./fixture-format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPLETIONS_DIR = path.join(__dirname, "fixtures", "completions");

// The committed completions carry no {{ORDER_ID}} templates (ids enter via
// the resolve stage, not the prompt) — bind a dummy map so an accidentally
// introduced template fails loudly here instead of only in the container run.
const SUBS = { ORDER_ID: "t26b-order-unit-test" } as const;

async function loadEntries(): Promise<ScriptedEntry[]> {
  return loadScriptedEntries(COMPLETIONS_DIR, SUBS);
}

function toRequest(entry: ScriptedEntry): CompletionRequest {
  return {
    model: "claude-sonnet-4-6",
    ...(entry.request.system !== undefined
      ? { system: entry.request.system }
      : {}),
    messages: entry.request.messages,
    ...(entry.request.tools !== undefined
      ? { tools: entry.request.tools }
      : {}),
    maxTokens: 1024,
  };
}

describe("content-keyed scripted provider — key derivation (T2-6b acceptance)", () => {
  it("resolves the recorded planner fixture by content", async () => {
    const entries = await loadEntries();
    const provider = createScriptedModelProvider({ entries });
    const planner = entries.find(
      (e) => e.label === "planner:cancel-confirm-gate",
    );
    expect(planner).toBeDefined();

    const completion = await provider.complete(
      toRequest(planner as ScriptedEntry),
    );
    expect(completion.toolCalls?.[0]?.name).toBe("express_intent");
    expect(
      (completion.toolCalls?.[0]?.input as { capability?: string }).capability,
    ).toBe("order.cancel");
  });

  it("a ONE-CHAR system-prompt mutation produces a DIFFERENT content key and a loud unknown-key error naming the nearest fixture", async () => {
    const entries = await loadEntries();
    const provider = createScriptedModelProvider({ entries });
    const planner = entries.find(
      (e) => e.label === "planner:cancel-confirm-gate",
    ) as ScriptedEntry;

    const recordedKey = deriveContentKey(planner.request);
    const mutated: CompletionRequest = {
      ...toRequest(planner),
      // The temporary one-char prompt mutation of the acceptance criterion.
      system: `${planner.request.system ?? ""}!`,
    };

    expect(deriveContentKey(mutated)).not.toBe(recordedKey);

    // Loud, diagnosable, never a silent fallback: the error names the
    // derived key and ranks the drifted fixture's own family nearest.
    await expect(provider.complete(mutated)).rejects.toThrow(
      /no scripted completion for content key/,
    );
    await expect(provider.complete(mutated)).rejects.toThrow(
      /planner:cancel-confirm-gate/,
    );
  });

  it("a tool-surface mutation also changes the key (capability drift breaks fixtures)", async () => {
    const entries = await loadEntries();
    const planner = entries.find(
      (e) => e.label === "planner:cancel-confirm-gate",
    ) as ScriptedEntry;
    const tools = planner.request.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);

    const mutatedTools = tools.map((t, i) =>
      i === 0 ? { ...t, description: `${t.description}.` } : t,
    );
    expect(
      deriveContentKey({ ...planner.request, tools: mutatedTools }),
    ).not.toBe(deriveContentKey(planner.request));
  });

  it("the key deliberately EXCLUDES the model id (DR-1: certification-target moves must not invalidate recordings)", async () => {
    const entries = await loadEntries();
    const provider = createScriptedModelProvider({ entries });
    const responder = entries.find(
      (e) => e.label === "responder:smalltalk-noop",
    ) as ScriptedEntry;

    const onOtherModel = await provider.complete({
      ...toRequest(responder),
      model: "claude-some-future-model",
    });
    expect(onOtherModel.text).toBe(responder.response.text);
  });

  it("canonicalization is object-key-order-insensitive but array-order-sensitive", () => {
    const a = canonicalizeRequestContent({
      system: "s",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          name: "t",
          description: "d",
          inputSchema: { type: "object", properties: { a: 1, b: 2 } },
        },
      ],
    });
    const b = canonicalizeRequestContent({
      system: "s",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          name: "t",
          description: "d",
          inputSchema: { properties: { b: 2, a: 1 }, type: "object" },
        },
      ],
    });
    expect(a).toBe(b);

    const twoMessages = (order: "ab" | "ba"): string =>
      canonicalizeRequestContent({
        messages:
          order === "ab"
            ? [
                { role: "user", content: "a" },
                { role: "assistant", content: "b" },
              ]
            : [
                { role: "assistant", content: "b" },
                { role: "user", content: "a" },
              ],
      });
    expect(twoMessages("ab")).not.toBe(twoMessages("ba"));
  });

  it("absent tools and empty tools are DIFFERENT requests (responder vs zero-tool planner)", () => {
    const base = {
      system: "s",
      messages: [{ role: "user" as const, content: "x" }],
    };
    expect(deriveContentKey(base)).not.toBe(
      deriveContentKey({ ...base, tools: [] }),
    );
  });
});
