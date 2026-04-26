# @ibx/intent-llm

Capability planner + prompt renderer + tool classification for IBX-IGE.

## CapabilityPlanner — security-sensitive

```ts
interface CapabilityPlanner<S, C> {
  plan(state: S, context: C): Plan;
}

interface Plan {
  visibleReadTools: ReadonlyArray<string>;   // READ tools the LLM may call directly
  allowedIntents:   ReadonlyArray<string>;   // Intent kinds the LLM may propose
  forbiddenConcepts: ReadonlyArray<string>;  // Negative constraints for the prompt
}
```

A misbehaving planner widens the attack surface. **Unit-test the planner at
byte level.** The renderer that consumes it is only cosmetic.

## PromptRenderer — cosmetic

```ts
interface PromptRenderer<S, C> {
  render(state: S, context: C, plan: Plan, modifiers?: SupervisorModifiers): RenderedPrompt;
}
```

Consumes the plan produced upstream. Responsible for prompt text layout,
token budgeting, and tone modulation. Does NOT make capability decisions.

## ToolClassification — structural separation

```ts
interface ToolClassification<Read extends string, Mutating extends string> {
  READ_ONLY: ReadonlySet<Read>;
  MUTATING:  ReadonlySet<Mutating>;
}

filterReadOnly(classification, ["search", "add_to_cart"])
  // → ["search"] — MUTATING tools are structurally removed
```

This is the function the PromptSynthesizer uses to hide MUTATING tools from
the LLM. They literally do not appear in the serialized tool list.

## Testing the split

- Planner: byte-level unit tests matching the historical `STATE_TOOLS` map
- Renderer: snapshot tests matching prior prompt output

If you ever change the planner, the invariant property tests in
`@ibx/intent-kernel/tests/invariants/` still protect you — UNTRUSTED can
never EXECUTE when policy demands SYSTEM, regardless of which tools were
offered to the LLM.
