// T2-6b — content-keyed scripted ModelProvider (the zero-token SUT double).
//
// Implements the FULL @claustrum/core ModelProvider port (complete + stream +
// embed) over a fixture table keyed by CONTENT — a canonicalized sha256 digest
// of `{system, messages, tools}` — NOT a call cursor. The upstream
// `InMemoryModelProvider` test double is a content-blind modulo cursor
// (plan v2 ledger #13): out-of-order or repeated calls silently rotate the
// script, which makes golden-conversation fixtures lie. Here:
//
//   - repeated/out-of-order calls resolve deterministically (same request
//     content → same scripted completion, forever);
//   - an UNKNOWN request is a LOUD error naming the derived key, a request
//     summary, and the nearest registered fixtures — never a silent fallback;
//   - the content key INCLUDES the system prompt and the tool surface, so a
//     planner-prompt or capability-surface change breaks fixtures by
//     construction (the T2-6b acceptance criterion);
//   - the key deliberately EXCLUDES the model id: the DR-1 certification
//     target can move (e.g. a model alias bump) without invalidating recorded
//     conversations — prompts and tool surfaces are the contract, not vendor
//     model strings. maxTokens/temperature are tuning, also excluded.
//
// `embed` is IMPLEMENTED (deterministic text-derived vector) even though the
// production AnthropicProvider throws `not_implemented` without an embedding
// proxy (D-009): the pgvector grounding provider calls `embed(perception.text)`
// on EVERY turn, and scripted fixtures must be able to exercise the grounding
// path when its schema exists. Production stays fail-safe-wrapped; the
// scripted double must not be the reason a grounding fixture can't run.
//
// Fixture authoring: run the consuming suite with
// `IBX_SCRIPTED_CAPTURE_DIR=/tmp/some-dir` — every unresolved request is
// written there as `<key>.json` (canonical request, pretty-printed) and a
// benign placeholder completion is returned so the WHOLE conversation flows
// and all of a turn's requests (planner + responder) are captured in one run.
// Capture mode is for authoring only; assertions are expected to fail under
// it. The default (no env var) is the loud error.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type CancellableStream,
  type Completion,
  type CompletionChunk,
  type CompletionRequest,
  type ModelProvider,
} from "@claustrum/core";

// ── Canonicalization + content key ───────────────────────────────────────────

/** The slice of CompletionRequest that participates in the content key. */
export interface ScriptedRequestContent {
  readonly system?: string;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "tool";
    readonly content: string;
  }>;
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
  }>;
}

/**
 * Deep key-sorted JSON. Object keys are sorted so two structurally-equal
 * inputSchemas serialize identically; ARRAY ORDER IS PRESERVED — message
 * order and tool order are content (a reordered tool surface IS drift).
 */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJson(v)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
    .join(",")}}`;
}

/**
 * Canonical string form of the content-keyed request slice. Absent `system`
 * / `tools` canonicalize to `null` (distinct from empty string / empty
 * array — "no tool surface" and "zero tools" are different requests).
 */
export function canonicalizeRequestContent(
  req: ScriptedRequestContent,
): string {
  return stableJson({
    system: req.system ?? null,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    tools:
      req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })) ?? null,
  });
}

/** sha256 over the canonical form, truncated to 16 hex chars. */
export function deriveContentKey(req: ScriptedRequestContent): string {
  return createHash("sha256")
    .update(canonicalizeRequestContent(req))
    .digest("hex")
    .slice(0, 16);
}

// ── Scripted entries ─────────────────────────────────────────────────────────

export interface ScriptedCompletion {
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }>;
  readonly stopReason?: Completion["stopReason"];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ScriptedEntry {
  /** Human handle used in error messages, e.g. "planner:cancel-confirm-gate". */
  readonly label: string;
  readonly request: ScriptedRequestContent;
  readonly response: ScriptedCompletion;
}

export interface ScriptedCall {
  readonly method: "complete" | "stream" | "embed";
  /** Content key of the request (embed: key over the text). */
  readonly key: string;
  /** Label of the entry that resolved it; null = capture-mode placeholder. */
  readonly label: string | null;
}

export interface ScriptedModelProvider extends ModelProvider {
  /** Every call the SUT made, in order — assert call profiles in tests. */
  readonly calls: ReadonlyArray<ScriptedCall>;
  /** Registered entries (key → label), for diagnostics. */
  readonly entries: ReadonlyMap<string, string>;
}

export interface CreateScriptedModelProviderOptions {
  readonly entries: ReadonlyArray<ScriptedEntry>;
  /** Dimensions of the deterministic embed vector. Default 8. */
  readonly embedDimensions?: number;
}

const CAPTURE_ENV = "IBX_SCRIPTED_CAPTURE_DIR";

function summarizeRequest(req: ScriptedRequestContent): string {
  const sys = req.system === undefined ? "<none>" : truncate(req.system, 72);
  const first = req.messages[0];
  const msg =
    first === undefined
      ? "<none>"
      : `${first.role}: ${truncate(first.content, 72)}`;
  const tools =
    req.tools === undefined
      ? "<none>"
      : `[${req.tools
          .slice(0, 3)
          .map((t) => t.name)
          .join(", ")}${req.tools.length > 3 ? `, +${req.tools.length - 3}` : ""}]`;
  return `system=${sys} | messages=${req.messages.length} (${msg}) | tools=${tools}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function sharedPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Create the content-keyed scripted provider. Registration fails loudly on
 * a duplicate content key with a DIFFERENT label (two fixtures claiming one
 * request is ambiguity, not convenience); identical (key, label) re-registration
 * is idempotent so shared surfaces can be loaded by multiple suites.
 */
export function createScriptedModelProvider(
  options: CreateScriptedModelProviderOptions,
): ScriptedModelProvider {
  const byKey = new Map<string, ScriptedEntry & { readonly canonical: string }>();
  for (const entry of options.entries) {
    const canonical = canonicalizeRequestContent(entry.request);
    const key = deriveContentKey(entry.request);
    const existing = byKey.get(key);
    if (existing && existing.label !== entry.label) {
      throw new Error(
        `[scripted-model-provider] duplicate content key ${key}: ` +
          `'${existing.label}' and '${entry.label}' canonicalize to the same request`,
      );
    }
    byKey.set(key, { ...entry, canonical });
  }

  const calls: ScriptedCall[] = [];
  const embedDimensions = options.embedDimensions ?? 8;

  function resolve(req: CompletionRequest): {
    key: string;
    entry: (ScriptedEntry & { canonical: string }) | null;
  } {
    const key = deriveContentKey(req);
    const entry = byKey.get(key) ?? null;
    if (entry !== null) return { key, entry };

    // Capture mode (fixture authoring): persist the canonical request and
    // return a placeholder so the rest of the turn's requests also surface.
    const captureDir = process.env[CAPTURE_ENV];
    if (captureDir !== undefined && captureDir.length > 0) {
      mkdirSync(captureDir, { recursive: true });
      writeFileSync(
        path.join(captureDir, `${key}.json`),
        JSON.stringify(
          {
            key,
            request: {
              system: req.system ?? null,
              messages: req.messages,
              tools: req.tools ?? null,
            },
          },
          null,
          2,
        ),
      );
      return { key, entry: null };
    }

    // Loud unknown-key error: derived key + request summary + nearest
    // registered fixtures (ranked by canonical-JSON shared prefix — system
    // prompts lead the canonical form, so prompt drift ranks its own family
    // of fixtures first). NEVER a silent fallback.
    const canonical = canonicalizeRequestContent(req);
    const nearest = [...byKey.values()]
      .map((e) => ({
        label: e.label,
        key: deriveContentKey(e.request),
        shared: sharedPrefixLength(canonical, e.canonical),
      }))
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 3);
    throw new Error(
      `[scripted-model-provider] no scripted completion for content key ${key}.\n` +
        `request: ${summarizeRequest(req)}\n` +
        `registered entries: ${byKey.size}\n` +
        (nearest.length > 0
          ? `nearest fixtures by canonical prefix:\n${nearest
              .map(
                (n, i) =>
                  `  ${i + 1}. ${n.label} (key ${n.key}, shared prefix ${n.shared} chars)`,
              )
              .join("\n")}\n`
          : "") +
        `A changed planner/responder prompt or tool surface changes the content key — ` +
        `re-record the fixture if the change is intended. ` +
        `Set ${CAPTURE_ENV} to capture canonical requests for authoring.`,
    );
  }

  function toCompletion(
    req: CompletionRequest,
    scripted: ScriptedCompletion | null,
  ): Completion {
    if (scripted === null) {
      // Capture-mode placeholder — clearly marked, zero tool calls.
      return {
        model: req.model,
        stopReason: "end_turn",
        text: "[scripted-capture-placeholder]",
        inputTokens: 0,
        outputTokens: 0,
      };
    }
    const toolCalls = scripted.toolCalls;
    return {
      model: req.model,
      stopReason:
        scripted.stopReason ??
        (toolCalls !== undefined && toolCalls.length > 0
          ? "tool_use"
          : "end_turn"),
      text: scripted.text ?? "",
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      inputTokens: scripted.inputTokens ?? 0,
      outputTokens: scripted.outputTokens ?? 0,
    };
  }

  return {
    calls,
    get entries(): ReadonlyMap<string, string> {
      return new Map([...byKey.entries()].map(([k, e]) => [k, e.label]));
    },

    async complete(req: CompletionRequest): Promise<Completion> {
      const { key, entry } = resolve(req);
      calls.push({ method: "complete", key, label: entry?.label ?? null });
      return toCompletion(req, entry?.response ?? null);
    },

    stream(req: CompletionRequest): CancellableStream<CompletionChunk> {
      // Resolve EAGERLY so an unknown request fails at call time (matching
      // complete()), not at first iteration.
      const { key, entry } = resolve(req);
      calls.push({ method: "stream", key, label: entry?.label ?? null });
      const completion = toCompletion(req, entry?.response ?? null);

      let cancelled = false;
      async function* generate(): AsyncGenerator<CompletionChunk> {
        if (cancelled) {
          yield { type: "cancelled", inputTokens: 0, outputTokens: 0 };
          return;
        }
        if (completion.text.length > 0) {
          yield { type: "text_delta", text: completion.text };
        }
        for (const call of completion.toolCalls ?? []) {
          if (cancelled) break;
          yield { type: "tool_use_start", id: call.id, name: call.name };
          yield {
            type: "tool_input_delta",
            id: call.id,
            delta: JSON.stringify(call.input ?? {}),
          };
        }
        if (cancelled) {
          yield {
            type: "cancelled",
            inputTokens: completion.inputTokens,
            outputTokens: completion.outputTokens,
          };
          return;
        }
        yield {
          type: "done",
          stopReason: completion.stopReason,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
        };
      }
      const iterator = generate();
      return {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        cancel() {
          cancelled = true;
        },
        get aborted() {
          return cancelled;
        },
      };
    },

    async embed(text: string): Promise<number[]> {
      // Deterministic text-derived vector: sha256 bytes mapped to [-1, 1].
      // Same text → same vector, across processes and runs. NOT semantically
      // meaningful — fixtures that assert grounding RANKING must seed their
      // own vectors; this guarantees only determinism + correct shape.
      const digest = createHash("sha256").update(text).digest();
      const key = createHash("sha256")
        .update(`embed:${text}`)
        .digest("hex")
        .slice(0, 16);
      calls.push({ method: "embed", key, label: "embed:deterministic" });
      const vector: number[] = [];
      for (let i = 0; i < embedDimensions; i++) {
        const byte = digest[i % digest.length] ?? 0;
        vector.push(Number((byte / 127.5 - 1).toFixed(6)));
      }
      return vector;
    },
  };
}
