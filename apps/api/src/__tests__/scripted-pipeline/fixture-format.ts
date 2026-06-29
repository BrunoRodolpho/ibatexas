// T2-6b — golden-conversation fixture format (CC-006-compatible) + loader.
//
// BASE FORMAT (byte-compatible with the upstream golden-conversation runner —
// `@claustrum/conformance` CC-006 `few-shot-regression`, READ at
// claustrum/packages/conformance/src/checks/few-shot-regression.ts):
//
//   { id, scenario, conversation: [{role, content}...],
//     expectedEnvelopeKinds: string[], expectedDecisionKind: string, tags? }
//
// CC-006 drives the LAST user message of `conversation` through `handleTurn`
// for a synthetic customer `cc006-${id}` / conversation `cc006-conv-${id}` and
// compares the deduplicated envelope-kind set + the final Decision.kind. The
// upstream check ignores unknown fields, so the T2-6b extensions below ride
// the same files — a fixture stays loadable by stock CC-006 (which then
// verifies the base assertions only).
//
// T2-6b EXTENSIONS (consumed by golden-conversation-check.ts):
//   expectedRefusalCode      — REFUSE only: the stable Refusal.code.
//   expectAwaitingConfirmation — REQUEST_CONFIRMATION only: asserts the turn's
//                              response.meta.awaitingConfirmation AND that the
//                              envelope was parked in the session store.
//   expectedParkedPayload    — subset-match against the PARKED envelope's
//                              payload (template-substituted; this is where
//                              `{{ORDER_ID}}` lands — fixtures never commit
//                              raw Medusa ids, which are ULID-nondeterministic
//                              per seed; plan v2 ledger #15).
//   expectedResponseText     — exact final user-facing text (the scripted
//                              responder makes this deterministic).
//   expectedAudit            — intent_audit assertions for the turn's hashed
//                              session namespace (D-012): rows: count,
//                              and per-row kind/decision/refusalCode. The
//                              suite (not the check) owns the SQL.
//
// TEMPLATE SUBSTITUTION: every string value in a fixture (and in the
// completions files) may carry `{{KEY}}` placeholders, substituted AT LOAD
// from the suite's runtime map (e.g. ORDER_ID → the order seeded into the
// throwaway domain DB this run). Handles (kebab-case product handles) are the
// only stable identifiers allowed inline — ids are always templates.
//
// COMPLETIONS FORMAT (scripted-model-provider fixture side):
//   surfaces.json — the LITERAL prompt/tool surfaces the SUT is expected to
//     send: { planner: {system, tools}, responder: {system} }. These are
//     RECORDED bytes (via IBX_SCRIPTED_CAPTURE_DIR), not derived from SUT
//     code — deriving them would be circular and a prompt change would never
//     break a fixture. Because the content key covers {system, messages,
//     tools}, ANY SUT prompt/tool-surface drift makes the runtime request
//     miss the table and fail loudly (the T2-6b acceptance property).
//   <name>.completions.json — [{ label, surface: "planner"|"responder",
//     userText, response }] — each composes a full ScriptedEntry from the
//     shared surface + the turn's user text.

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ScriptedCompletion,
  ScriptedEntry,
} from "../helpers/scripted-model-provider.js";

// ── Fixture types ────────────────────────────────────────────────────────────

export interface GoldenConversationFixture {
  readonly id: string;
  readonly scenario: string;
  readonly conversation: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>;
  readonly expectedEnvelopeKinds: ReadonlyArray<string>;
  readonly expectedDecisionKind: string;
  readonly tags?: ReadonlyArray<string>;
  // ── T2-6b extensions ──
  readonly expectedRefusalCode?: string;
  readonly expectAwaitingConfirmation?: boolean;
  readonly expectedParkedPayload?: Readonly<Record<string, unknown>>;
  readonly expectedResponseText?: string;
  readonly expectedAudit?: {
    readonly rows: number;
    readonly records?: ReadonlyArray<{
      readonly kind: string;
      readonly decision: string;
      readonly refusalCode?: string | null;
    }>;
  };
}

export type TemplateSubstitutions = Readonly<Record<string, string>>;

// ── Template substitution ────────────────────────────────────────────────────

const TEMPLATE_RE = /\{\{([A-Z0-9_]+)\}\}/g;

export function applyTemplates<T>(value: T, subs: TemplateSubstitutions): T {
  if (typeof value === "string") {
    return value.replace(TEMPLATE_RE, (match, key: string) => {
      const replacement = subs[key];
      if (replacement === undefined) {
        throw new Error(
          `[fixture-format] unbound template ${match} — the suite must supply ` +
            `a substitution for every {{KEY}} in the fixtures (bound: ` +
            `${Object.keys(subs).join(", ") || "<none>"})`,
        );
      }
      return replacement;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => applyTemplates(v, subs)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyTemplates(v, subs);
    }
    return out as unknown as T;
  }
  return value;
}

// ── Loaders ──────────────────────────────────────────────────────────────────

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

/**
 * Load every `*.json` conversation fixture in `dir` (CC-006 discovery rule:
 * flat dir, `.json` suffix, sorted by id). Malformed base fields throw HERE —
 * unlike the defensive upstream loader, an adopter-committed fixture that
 * fails to parse is a bug, not something to skip silently.
 */
export async function loadGoldenFixtures(
  dir: string,
  subs: TemplateSubstitutions,
): Promise<GoldenConversationFixture[]> {
  const entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const fixtures: GoldenConversationFixture[] = [];
  for (const entry of entries) {
    const raw = await readJson<GoldenConversationFixture>(
      path.join(dir, entry),
    );
    if (
      typeof raw.id !== "string" ||
      !Array.isArray(raw.conversation) ||
      !Array.isArray(raw.expectedEnvelopeKinds) ||
      typeof raw.expectedDecisionKind !== "string"
    ) {
      throw new TypeError(
        `[fixture-format] ${entry} is not a valid CC-006-format fixture ` +
          `(id/conversation/expectedEnvelopeKinds/expectedDecisionKind required)`,
      );
    }
    fixtures.push(applyTemplates(raw, subs));
  }
  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  return fixtures;
}

// ── Completions ──────────────────────────────────────────────────────────────

interface SurfacesFile {
  readonly planner: {
    readonly system: string;
    readonly tools: ReadonlyArray<{
      readonly name: string;
      readonly description: string;
      readonly inputSchema: unknown;
    }>;
  };
  readonly responder: {
    readonly system: string;
  };
}

interface CompletionEntryFile {
  readonly label: string;
  readonly surface: "planner" | "responder";
  readonly userText: string;
  readonly response: ScriptedCompletion;
}

/**
 * Compose ScriptedEntry[] from the shared surfaces file + every
 * `*.completions.json` in `dir`. The composed request mirrors EXACTLY what
 * the SUT sends: planner — recorded system + single user message + recorded
 * tool surface; responder — recorded system + single user message, NO tools.
 */
export async function loadScriptedEntries(
  dir: string,
  subs: TemplateSubstitutions,
): Promise<ScriptedEntry[]> {
  const surfaces = applyTemplates(
    await readJson<SurfacesFile>(path.join(dir, "surfaces.json")),
    subs,
  );
  const files = (await fs.readdir(dir)).filter((f) =>
    f.endsWith(".completions.json"),
  );
  const entries: ScriptedEntry[] = [];
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    const rows = applyTemplates(
      await readJson<CompletionEntryFile[]>(path.join(dir, file)),
      subs,
    );
    for (const row of rows) {
      if (row.surface === "planner") {
        entries.push({
          label: row.label,
          request: {
            system: surfaces.planner.system,
            messages: [{ role: "user", content: row.userText }],
            tools: surfaces.planner.tools,
          },
          response: row.response,
        });
      } else {
        entries.push({
          label: row.label,
          request: {
            system: surfaces.responder.system,
            messages: [{ role: "user", content: row.userText }],
            // The responder sends NO tools — absent, not empty (distinct keys).
          },
          response: row.response,
        });
      }
    }
  }
  return entries;
}
