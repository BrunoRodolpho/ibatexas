/**
 * Tool classifier — type-level READ vs MUTATING separation.
 *
 * Adopters build their TOOL_CLASSIFICATION value as a `ToolClassification`
 * and pass it to the planner. The type system enforces the partition: a tool
 * name can belong to exactly one of the two sets at registration time.
 *
 * When the v2.0 split lands and this package becomes `@adjudicate/intent-runtime-xstate`,
 * the ToolClassification interface stays here — it is runtime-agnostic.
 */

export interface ToolClassification<
  ReadTools extends string = string,
  MutatingTools extends string = string,
> {
  readonly READ_ONLY: ReadonlySet<ReadTools>;
  readonly MUTATING: ReadonlySet<MutatingTools>;
}

/** Runtime check — defends against dynamic (string) tool names at a boundary. */
export function isReadOnly(
  classification: ToolClassification,
  name: string,
): boolean {
  return classification.READ_ONLY.has(name);
}

export function isMutating(
  classification: ToolClassification,
  name: string,
): boolean {
  return classification.MUTATING.has(name);
}

/**
 * Filter a list of tool names down to the READ_ONLY subset. This is the
 * structural filter the PromptSynthesizer uses to hide MUTATING tools from
 * the LLM — they literally do not appear in the serialized tool list.
 */
export function filterReadOnly(
  classification: ToolClassification,
  tools: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return tools.filter((t) => classification.READ_ONLY.has(t));
}
