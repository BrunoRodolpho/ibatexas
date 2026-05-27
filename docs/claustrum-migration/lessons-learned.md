# Lessons Learned — `packages/llm-provider/`

> Anti-patterns mined from the deleted-soon `@ibatexas/llm-provider`
> package, using `git show pre-claustrum-cutover:...` against the recovery
> tag. Each lesson documents how the old code did it, why it eventually
> hurt, and how `@claustrum/*` fixes it.
>
> Negative knowledge captured here is the reason claustrum is a separate
> repo, not just a refactor inside ibatexas.

---

## 1. Tool ids leaked straight into LLM tool-use blocks

**Anti-pattern (from `packages/llm-provider/src/tool-registry.ts`):**

The Anthropic `TOOL_DEFINITIONS` array passed to `Anthropic.messages.create()`
was the **same** list of identifiers the kernel and tool-executor used as
internal keys. The LLM saw `"add_to_cart"`, `"create_checkout"`,
`"cancel_order"` etc. verbatim — there was no separation between the
**capability** the model is supposed to reason about and the **handler id**
the runtime uses to dispatch.

```ts
// tool-registry.ts
export async function executeTool(
  name: string,         // <-- LLM-supplied; raw handler id
  input: unknown,
  ctx: AgentContext,
  toolUseId?: string,
): Promise<ToolExecutionResult> {
  const handler = handlers.get(name)
  if (!handler) {
    throw new Error(`Ferramenta desconhecida: ${name}`)
  }
  // ...
}
```

**Why it hurt:** every rename of an internal handler was a breaking change
to the prompt surface; tool versioning was impossible without re-prompting
the model. There was no way to bind one capability to two different
implementations (e.g. a feature-flagged variant).

**Claustrum's fix:** capability/id split is sealed in `@claustrum/core`'s
`ToolDefinition`. The LLM **never** sees `id`; it only ever calls
`express_intent(capability, payload)`. The runtime resolves
`capability → id` after `adjudicate()` returns EXECUTE. See
`apps/api/src/tools/register-ibatexas-tool-packs.ts` — each entry carries
both `id` (e.g. `"ibatexas.cart.addItem.v1"`) and `capability` (e.g.
`"cart.add_item"`); only the capability is advertised to the planner.

---

## 2. Business logic lived inside the conversational machine

**Anti-pattern (from `packages/llm-provider/src/machine/order-machine.ts`):**

A single XState machine encoded **both** the conversational flow (greeting,
asking, confirming) **and** the commerce-domain rules (availability checks,
cart guards, fulfillment selection, checkout sequencing, post-order
amendments, payment retry):

```ts
type InternalEvent =
  | { type: "SEARCH_RESULT"; found: boolean; products: unknown[]; ... }
  | { type: "CART_UPDATED"; success: boolean; cartId: string; ... }
  | { type: "DELIVERY_RESULT"; inZone: boolean; ... }
  | { type: "CHECKOUT_RESULT"; success: boolean; ... }
  | { type: "PAYMENT_STATUS_CHANGED"; paymentId: string; ... }
  | { type: "REGENERATE_PIX" }
  // ...
```

**Why it hurt:** the runtime could not be reused by any project that didn't
sell food. Healthcare, scheduling, support — none of them have a `CART_UPDATED`
event, but they all need the same cognitive loop (perceive, plan, submit,
act, observe). The machine was a domain artifact pretending to be a runtime.

**Claustrum's fix:** the cognitive loop in `@claustrum/core` is
domain-neutral. Every mutation is an **IntentEnvelope** with a generic
`kind` field, adjudicated by the kernel. Domain entities (Cart, Order,
Payment) stay in ibatexas's `packages/domain/`; the runtime only sees
capabilities and envelopes. The XState machine itself is not carried
forward — it was app-domain state, never runtime concern.

---

## 3. Two parallel execution paths for the same tool

**Anti-pattern (from `packages/llm-provider/src/tool-registry.ts`):**

To prevent prompt injection from triggering mutations, the package shipped
**two** entry points to the same handler:

```ts
// LLM-facing — returns an "intent" sentinel for mutating tools, executes for read-only
export async function executeTool(name, input, ctx, toolUseId)
  : Promise<ToolExecutionResult> { ... }

// Kernel-only — bypasses the intent bridge, always executes
export async function executeToolDirect(name, input, ctx)
  : Promise<unknown> { ... }
```

The right path was chosen by reading a static set:

```ts
if (TOOL_CLASSIFICATION.READ_ONLY.has(name)) {
  const data = await handler(input, ctx)
  return { kind: "result", data }
}
// else: return { kind: "intent", ... } and let the machine call executeToolDirect later
```

**Why it hurt:** every new tool had to be classified in `TOOL_CLASSIFICATION`
in `packages/llm-provider/src/machine/types.ts`, and forgetting to add it
defaulted to **executing** it — silently re-introducing the very attack
surface the intent bridge was supposed to close. The classification was
review-only enforcement; there was no compile-time guarantee.

**Claustrum's fix:** the kernel boundary is the only execution path.
`adjudicate(envelope, state, policy)` returns a typed `Decision` variant
(`EXECUTE` | `REFUSE` | `DEFER` | `ASK` | `HANDOFF`), and the runtime's
`Conductor.act()` is the **only** place that resolves EXECUTE to a tool
invocation. There is no second entry point. Forgetting to add a tool to
the registry means it doesn't exist, not that it executes unauthenticated.

---

## 4. Prompt assembly was a 4-layer side-effect pipeline

**Anti-pattern (from `packages/llm-provider/src/agent.ts` +
`prompt-synthesizer.ts`):**

`runAgent()` was a 200+ LOC async generator that interleaved:

1. Loading persisted XState snapshot from Redis
2. Routing the message through keyword regex (`routeMessage`)
3. Mutating the snapshot via the machine
4. Reading cart/customer state from Postgres mid-loop
5. Synthesizing a per-state prompt (`synthesizePrompt`) by string-concatenating
   sections from `prompt-sections.ts`
6. Calling the LLM with the result
7. On tool-use, executing the tool, looping back to step 5

There was **no record** of which prompt fragments contributed to which LLM
call. Debugging a hallucinated reply meant manually rerunning the agent
locally and printing the synthesized string.

**Why it hurt:** no audit trail of the prompt → no way to do prompt
regression testing → every prompt tweak risked silently breaking an
unrelated state. Token-savings claims ("3,400 → ~400 tokens/turn")
couldn't be enforced because the prompt was reconstructed from scratch
every turn from imperative code.

**Claustrum's fix:** `PromptComposer` in `@claustrum/core` operates on a
**fragment registry**. Each fragment has an id, a version, and a hash.
Every LLM call records a **prompt manifest** (`{ fragmentIds, hashes,
totalTokens }`) into the audit record. The conformance suite verifies
"prompt manifest recorded in every LLM trace" as an invariant — there is
no path to call the LLM without writing the manifest. Stable, replayable,
diffable.

---

## 5. Latency budget enforcement was bolted on top, not inside

**Anti-pattern (from `packages/llm-provider/src/orchestrator.ts`):**

The "Orchestrator" wrapped `runAgent()` with a hard 4s deadline using
`Promise.race`:

```ts
const raceResult = await Promise.race([
  generator.next(),
  deadlinePromise,
])

if (raceResult === DEADLINE_HIT) {
  console.warn("[orchestrator] Hard deadline hit — yielding state-aware fallback")
  if (textEmitted) {
    yield { type: "text_delta", delta: "..." }
    yield { type: "done" }
    generator.return(undefined)
    abortController.abort()
    return
  }
  // ... yield deterministic fallback ...
}
```

The deadline was external to the work. A blocked `processCheckout` (30s
timeout) inside the kernel would happily run past 4s — only the
**consumer's** generator.next() was abandoned, not the upstream HTTP call.

**Why it hurt:** "best-effort cancellation" meant pending kernel calls
continued to consume Anthropic tokens and Postgres connections after the
user had already received a fallback. Worse, partial responses got
emitted alongside the fallback (the `textEmitted` guard was a patch on
the patch).

**Claustrum's fix:** cancellation is a first-class concern of the
`ModelProvider` port. `@claustrum/anthropic`'s streaming returns a
`Stream` whose `.cancel()` actually severs the upstream HTTP connection.
The Conductor's deadline is propagated through the cognitive loop, not
wrapped around it. When the kernel returns `DEFER`, the envelope is
parked by `intentHash` — long-running work is the kernel's responsibility,
not a race condition the runtime patches over.

---

## 6. Forbidden-phrase regexes guarded against hallucinations after the fact

**Anti-pattern (from `packages/llm-provider/src/validation-layer.ts`):**

To prevent the LLM from saying "pedido confirmado!" before the checkout
tool actually ran, the package shipped state-specific regex blocklists:

```ts
const POST_ORDER_FORBIDDEN: RegExp[] = [
  /pedido\s+cancelado/i,
  /cancelamento\s+confirmado/i,
  /pedido\s+alterado/i,
  // ... 8 more variants per state ...
]

const CHECKOUT_FORBIDDEN: RegExp[] = [
  /vou\s+encaminhar/i,
  /sistema\s+processa/i,
  /processando/i,
  // ... pt-BR specific, hand-maintained ...
]
```

Streamed text was **buffered** while tools were available, validated
against the forbidden list, and only then committed to the wire.

**Why it hurt:** brittle by design. Every new way of phrasing "confirmed"
in pt-BR (and the LLM is creative) required a new regex. The list was
incomplete the day it was committed, and would have been incomplete
forever. Worse, buffering added latency without solving the underlying
problem: the **prompt** should never have permitted the LLM to commit to
outcomes that hadn't happened yet.

**Claustrum's fix:** two layers, both upstream of generation:
1. `adjudicateOutput()` runs **per-chunk** while the model streams — the
   kernel can refuse mid-sentence and the stream is cancelled at the HTTP
   layer.
2. The prompt composer never includes "you have already done X" framing
   when X is a mutation pending adjudication. The capability advertised
   to the LLM is `express_intent`, not `execute`. Linguistically the model
   can only say "I'll do X" not "I did X" until the runtime confirms.

---

## 7. Adjudicate integration was an ad-hoc wrapper, not a port

**Anti-pattern (from `packages/domain/src/services/__shared__/with-adjudicate.ts`,
to be deleted — and from sprinkled `executeToolDirect` calls):**

Domain services that needed to gate a mutation through `@adjudicate/core`
imported it directly and wrapped the handler call inline:

```ts
// pseudo-flow from the pre-cutover code base:
import { adjudicate } from "@adjudicate/core"

async function cancelOrder(input, ctx) {
  const envelope = buildEnvelopeFromContext(input, ctx)  // ad-hoc per service
  const decision = await adjudicate(envelope, state, policy)
  if (decision.kind !== "EXECUTE") { /* handle */ }
  return executeToolDirect("cancel_order", input, ctx)
}
```

The envelope-building logic was duplicated. The decision-handling switch
was duplicated. Every new mutation re-implemented the same boilerplate;
every bug in envelope construction had to be fixed N times.

**Why it hurt:** the kernel boundary was a convention, not a constraint.
Reviewers had to manually check each service to confirm it adjudicated;
forgotten adjudicate calls had no compile-time error. The "three-layer
defense model" from ADR #4 partially compensated, but only at the
`customerId` axis — not at the capability axis.

**Claustrum's fix:** `Adjudicator` is a sealed port in `@claustrum/core`.
Adopters wire a single `adjudicateBridge()` once in their bootstrap
(`apps/api/src/claustrum-bootstrap.ts`). Inside `handleTurn`, the conductor
calls `capsule.adjudicator.adjudicate(envelope, state, policy)` **exactly
once** per turn; the Decision-handling switch lives in the cognitive
loop, not in domain services. Domain services receive `EXECUTE` results
already validated. The kernel boundary is enforced by **types** (Capsule
exposes `adjudicator` not the raw `@adjudicate/core` module) and by
review rule (boundary discipline in claustrum's CLAUDE.md: never
`import "@adjudicate/core"` from packs/* or routes/*).
