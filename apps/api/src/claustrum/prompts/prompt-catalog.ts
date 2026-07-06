// Prompt catalog — the single enumeration of every LLM-facing prompt the
// ibatexas agent runtime uses, for the qa-viewer "Prompts" navigate+edit view.
//
// Each entry maps a stable `id` (the fragment/persona key already used in
// turn_trace manifests and the prompt_override table) to its compiled-in
// default text, the pipeline stage, and whether an override is WIRED to take
// effect at runtime (i.e. the assembly seam consults resolvePrompt(id, CONST)).
// `wired: false` entries are navigable/readable but not yet live-editable —
// surfaced honestly so an edit is never silently ignored.

import { IBATEXAS_CAPABILITY_DESCRIPTIONS } from "../../tools/register-ibatexas-tool-packs.js";
import {
  CLAIM_PLANNER_PERSONA,
  OPS_PLANNER_PERSONA,
  OPS_RESPONDER_GROUNDED_PERSONA_PTBR,
  OPS_RESPONDER_PERSONA_PTBR,
  PLANNER_PERSONA,
  RESPONDER_ESCALATE_PTBR,
  RESPONDER_GROUNDED_PERSONA_PTBR,
  RESPONDER_PERSONA_PTBR,
} from "./personas.js";

export type PromptStage = "planner" | "claims" | "responder" | "ops" | "capability";

export interface PromptCatalogEntry {
  /** Stable id — the prompt_override key and turn_trace manifest fragment id. */
  readonly id: string;
  /** Human label for the list. */
  readonly name: string;
  readonly stage: PromptStage;
  /** How the text is authored in source (all are compiled-in strings today). */
  readonly kind: "persona" | "capability" | "fixed-reply";
  /** Source location for the operator's reference. */
  readonly path: string;
  /** true ⇒ an override consulted at the assembly seam takes effect at runtime. */
  readonly wired: boolean;
  /** The compiled-in default text (the fallback resolvePrompt returns). */
  readonly source: string;
}

const PERSONAS: PromptCatalogEntry[] = [
  {
    id: "ibatexas/planner.persona",
    name: "Customer planner persona",
    stage: "planner",
    kind: "persona",
    path: "apps/api/src/claustrum/prompts/personas.ts:21 (PLANNER_PERSONA)",
    wired: true, // composer chokepoint (ibatexas-prompts.ts staticFragment)
    source: PLANNER_PERSONA,
  },
  {
    id: "ibatexas/claim-planner.persona",
    name: "Claim planner persona (Track A)",
    stage: "claims",
    kind: "persona",
    path: "apps/api/src/claustrum/prompts/personas.ts:52 (CLAIM_PLANNER_PERSONA)",
    wired: true, // ibatexas-planner.ts:1001 fallback wrap
    source: CLAIM_PLANNER_PERSONA,
  },
  {
    id: "ibatexas/responder.persona",
    name: "Responder persona (conversational)",
    stage: "responder",
    kind: "persona",
    path: "apps/api/src/claustrum/prompts/personas.ts:74 (RESPONDER_PERSONA_PTBR)",
    wired: true, // composer chokepoint
    source: RESPONDER_PERSONA_PTBR,
  },
  {
    id: "ibatexas/responder.grounded",
    name: "Responder persona (grounded)",
    stage: "responder",
    kind: "persona",
    path: "apps/api/src/claustrum/prompts/personas.ts:78 (RESPONDER_GROUNDED_PERSONA_PTBR)",
    wired: true, // composer chokepoint
    source: RESPONDER_GROUNDED_PERSONA_PTBR,
  },
  {
    id: "ibatexas/responder.escalate",
    name: "Escalate handoff line (fixed reply)",
    stage: "responder",
    kind: "fixed-reply",
    path: "apps/api/src/claustrum/prompts/personas.ts:94 (RESPONDER_ESCALATE_PTBR)",
    wired: true, // ibatexas-responder.ts escalate fallback wrap
    source: RESPONDER_ESCALATE_PTBR,
  },
  {
    id: "ops/planner.persona",
    name: "Ops planner persona (staff)",
    stage: "ops",
    kind: "persona",
    path: "apps/api/src/claustrum/prompts/personas.ts:113 (OPS_PLANNER_PERSONA)",
    wired: true, // ops-conductor.ts system injection wrap
    source: OPS_PLANNER_PERSONA,
  },
  {
    id: "ops/responder.persona",
    name: "Ops responder persona (conversational)",
    stage: "ops",
    kind: "persona",
    path: "apps/api/src/claustrum/prompts/personas.ts:155 (OPS_RESPONDER_PERSONA_PTBR)",
    wired: true, // ops-conductor.ts personas injection wrap
    source: OPS_RESPONDER_PERSONA_PTBR,
  },
  {
    id: "ops/responder.grounded",
    name: "Ops responder persona (grounded)",
    stage: "ops",
    kind: "persona",
    path: "apps/api/src/claustrum/prompts/personas.ts:164 (OPS_RESPONDER_GROUNDED_PERSONA_PTBR)",
    wired: true, // ops-conductor.ts personas injection wrap
    source: OPS_RESPONDER_GROUNDED_PERSONA_PTBR,
  },
];

const CAPABILITIES: PromptCatalogEntry[] = Object.entries(IBATEXAS_CAPABILITY_DESCRIPTIONS).map(
  ([kind, description]) => ({
    id: `ibatexas/capability.${kind}`,
    name: `Capability: ${kind}`,
    stage: "capability" as const,
    kind: "capability" as const,
    path: "apps/api/src/tools/register-ibatexas-tool-packs.ts (IBATEXAS_CAPABILITY_DESCRIPTIONS)",
    wired: true, // composer capabilityFragment chokepoint
    source: description,
  }),
);

/** Every navigable prompt, personas first then capability descriptions. */
export const PROMPT_CATALOG: readonly PromptCatalogEntry[] = [...PERSONAS, ...CAPABILITIES];

const BY_ID = new Map(PROMPT_CATALOG.map((e) => [e.id, e]));

export function promptById(id: string): PromptCatalogEntry | undefined {
  return BY_ID.get(id);
}
