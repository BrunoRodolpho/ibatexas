# ibatexas as a Claustrum Adopter

> Reference for how ibatexas now consumes `@claustrum/*`. Use this as the
> template for any other application that wants to adopt the runtime.
>
> ibatexas is the **first** adopter; a second example
> (`examples/healthcare-stub/` or `examples/scheduling-stub/`) lives in the
> claustrum repo and was written by `reference-app-builder` specifically
> to prove the runtime is not ibatexas-specific.

---

## Mental model

```
┌─────────────────────────────────────────────────────────────┐
│ Apps  (ibatexas)                                            │
│  - Domain entities (Cart, Order, Payment, Customer)         │
│  - Domain tools (addToCart, cancelOrder, ...)               │
│  - Tenant policy + commerce rules                           │
│  - HTTP routes (chat.ts, whatsapp-webhook.ts)               │
└─────────────────────────────────────────────────────────────┘
                       ↓ consumes
┌─────────────────────────────────────────────────────────────┐
│ Runtime  (@claustrum/*)                                     │
│  - Conductor + Capsule + handleTurn cognitive loop          │
│  - ModelProvider, ChannelDriver, MemoryProvider, ...        │
│  - PromptComposer + ToolRegistry (capability/id split)      │
└─────────────────────────────────────────────────────────────┘
                       ↓ consumes
┌─────────────────────────────────────────────────────────────┐
│ Kernel  (@adjudicate/*)                                     │
│  - IntentEnvelope + Decision + AuditRecord                  │
│  - adjudicate() — sole mutation gate                        │
│  - intent_audit ledger                                      │
└─────────────────────────────────────────────────────────────┘
```

**Evolution rate:** kernel rarely changes (months-to-years), runtime
changes moderately (weeks-to-months), apps change daily. The packaging
boundary forces these tempos to stay decoupled.

---

## Boot wiring

`apps/api/src/claustrum-bootstrap.ts` is the **composition root** for the
chat surface. It is called once at process start (`server.ts`, after
Fastify is instantiated) and exports a singleton `Conductor`:

```ts
// claustrum-bootstrap.ts (excerpt)
import { createConductor, type Conductor, type Capsule } from "@claustrum/core";
import { AnthropicProvider } from "@claustrum/anthropic";
import { createPostgresMemoryProvider } from "@claustrum/memory-postgres";
import { createPgVectorGroundingProvider } from "@claustrum/grounding-pgvector";
import { WhatsAppChannel } from "@claustrum/channel-whatsapp";
import { WebChannel } from "@claustrum/channel-web";

export async function bootstrapClaustrum(): Promise<Conductor> {
  installFirstPartyPacks();  // MUST run BEFORE conductor creation
  _conductor = createConductor({
    modelProvider: new AnthropicProvider(/* sdk client */),
    memory:       createPostgresMemoryProvider(/* prisma + redis */),
    grounding:    createPgVectorGroundingProvider(/* pg pool */),
    channels:     { whatsapp: WhatsAppChannel, web: WebChannel },
    adjudicator:  adjudicateBridge(),   // wraps @adjudicate/core
    planner:      naivePlanner(),
    responder:    anthropicResponder(),
    explainer:    ibatexasExplainer(),
    handoff:      noopHandoff(),
    telemetry:    fastifyTelemetry(),
    session:      redisSessionStore(),
    toolRegistry: createToolRegistry(IBATEXAS_TOOLS),
    tenantPolicy: resolveIbatexasTenantPolicy,
  });
  return _conductor;
}

export function getConductor(): Conductor { return _conductor; }
```

**Critical ordering rule (load-bearing):**

> `installFirstPartyPacks()` **MUST** run before `assertAuditPostgresReady()`
> because policies use shared types from the packs.

Adopters that skip this hit a confusing "policy not found" error at first
adjudicate() call.

**Boundary discipline (enforced by claustrum CLAUDE.md):**

- The `Adjudicator` is the **only** kernel-facing port. Never
  `import "@adjudicate/core"` from inside `packs/*` or `routes/*`. Always
  go through `capsule.adjudicator`.
- The Capsule is **per-turn**; the Conductor is **process-wide**.

---

## Tool registration pattern

`apps/api/src/tools/register-ibatexas-tool-packs.ts` shows the canonical
shape. Each tool is registered with three identifiers:

```ts
import { addToCart } from "@ibatexas/tools";

makeTool({
  id:          "ibatexas.cart.addItem.v1",   // internal handler key
  capability:  "cart.add_item",              // what LLM sees (planner advertises)
  intentKind:  "order.item.add",             // matches @adjudicate envelope.kind
  description: "Adiciona um item ao carrinho do cliente",
  riskLevel:   "low",
  inputSchema:  AddToCartInputSchema,
  outputSchema: AddToCartOutputSchema,
  handler:     addToCart,
});
```

### The three identifiers

| Field | Who reads it | What it means |
|---|---|---|
| `id` | Runtime, internal | The handler key. **Never** advertised to the LLM. Versioned (`.v1`, `.v2`) so a tool can be swapped without retraining the model. |
| `capability` | LLM (via `express_intent` advertisement), audit log | Stable contract the model reasons about. Renames here are breaking changes to prompts. |
| `intentKind` | Kernel | Matches `IntentEnvelope.kind` exactly. The kernel's policy table is keyed by this. Renames here are breaking changes to policy. |

**LLM-facing surface:** the planner only ever advertises
`express_intent(capability, payload)`. The LLM **never** sees `id` or
`intentKind`. The runtime resolves `capability → id` after `adjudicate()`
returns `EXECUTE`, then dispatches the handler.

### Adding a new tool

1. Import the handler from `@ibatexas/tools`.
2. Copy its existing `intentKind` from
   `packages/llm-provider/src/machine/types.ts` `TOOL_CLASSIFICATION`
   (until that file is deleted; afterwards, look up the kind in
   `@ibatexas/types`).
3. Pick a stable `capability` string (`<domain>.<verb>` convention).
4. Pick a versioned `id` (`ibatexas.<domain>.<verb>.v<N>`).
5. Add to `IBATEXAS_TOOLS` in `register-ibatexas-tool-packs.ts`.

No code in routes or domain services changes. The new tool is reachable
the next time `bootstrapClaustrum()` runs.

---

## Per-request flow

Every chat request follows the same shape, whether from web SSE or
WhatsApp webhook:

```ts
// apps/api/src/routes/chat.ts (POST handler)
const conductor = getConductor();
const capsule = await conductor.openCapsule({
  channel: "web",
  customerId,
  sessionId,
});

try {
  const inbound: ChannelMessage = { /* normalised from req body */ };
  const turn = await handleTurn(capsule, inbound);
  // turn.response → stream chunks to SSE
  // turn.decision → already audited inside handleTurn
  // turn.audit    → AuditRecord id, already persisted to intent_audit
} finally {
  await conductor.closeCapsule(capsule);
}
```

```ts
// apps/api/src/routes/whatsapp-webhook.ts (after Twilio validation)
const conductor = getConductor();
const wa = conductor.channels.whatsapp;
const capsule = await conductor.openCapsule({
  channel: "whatsapp",
  customerId,
  sessionId,
});

const turn = await handleTurn(capsule, inbound);
await wa.render({ to: phoneNumber, response: turn.response });
await conductor.closeCapsule(capsule);
```

### What `handleTurn()` does

Inside `@claustrum/core`, `handleTurn` runs the cognitive loop:

```
perceive   ← channel-normalised ChannelMessage
understand ← intent reading + grounding retrieval
plan       ← planner emits IntentEnvelope
submit     ← adjudicator.adjudicate(envelope, state, policy)
act        ← on EXECUTE: capability → id → toolRegistry.execute(handler)
synthesize ← responder composes response using PromptComposer
observe    ← memory.observe(turn), telemetry record
```

**Invariants enforced by core (and verified by `@claustrum/conformance`):**

- `adjudicate()` is called **exactly once** per turn.
- The LLM never sees internal tool ids — only capabilities advertised via
  `express_intent`.
- Every LLM call records a prompt manifest in the audit record.
- Every EXECUTE Decision triggers exactly one tool invocation.
- Runtime never mutates state directly — only kernel does.

---

## Capsule vs RuntimeContext (load-bearing distinction)

Two similar names exist in the broader codebase. They are **not**
interchangeable:

| Name | Owner | Lifetime | Purpose |
|---|---|---|---|
| `Capsule` | `@claustrum/core` | One turn | Per-turn handle. Carries `adjudicator`, `memory`, `session`, `telemetry`. Routes hold a Capsule, never a Conductor's internals. |
| `RuntimeContext` | `@adjudicate/core` | One adjudicate call | Kernel-side execution context. The kernel passes it to policy guards. Never escapes the kernel boundary. |

When you see `ctx.adjudicate(...)` in a code review, **verify `ctx` is a
Capsule, not a RuntimeContext.** Confusing them means either (a) the
runtime is bypassing the adjudicator port (forbidden) or (b) the kernel
is being mutated by the runtime (forbidden).

ibatexas's `CLAUDE.md` will eventually carry a one-line clarification of
this distinction; until then, this doc is the canonical reference.

---

## Upgrade path

Same as `@adjudicate/*`, per ADR #14:

```bash
# In claustrum repo:
cd /Users/thaisrodolpho/projects/claustrum
pnpm changeset                    # describe the change
pnpm changeset version            # bump package versions
pnpm install && pnpm build
git commit && git push            # CI publishes to npm

# In ibatexas:
cd /Users/thaisrodolpho/projects/ibatexas
pnpm up '@claustrum/*'            # pick up new versions
pnpm install
pnpm --filter @ibatexas/api typecheck
# run tests, smoke the chat surface, commit
```

The `pnpm-workspace.yaml` entry for `../claustrum/packages/*` is a
**local development** shortcut — it lets the user edit both repos at once
and pick up changes without publishing. In CI/prod the workspace symlinks
fall through and `pnpm install` resolves the npm-published versions.

---

## What ibatexas does NOT do

Listed explicitly so reviewers can reject PRs that violate the boundary:

- **Cognitive loop.** Owned by `@claustrum/core`'s `handleTurn`. Adopters
  must not reimplement perceive/understand/plan/submit/act/synthesize/observe.
- **Prompt assembly.** Owned by `@claustrum/core`'s `PromptComposer` and
  fragment registry. Adopters register fragments; they don't string-concat
  prompts.
- **Channel rendering.** Owned by `WhatsAppChannel` / `WebChannel`.
  Adopters do not call the Twilio SDK directly from routes — they call
  `wa.render(...)`.
- **Kernel imports.** Adopters never `import "@adjudicate/core"` from a
  route or pack. Use `capsule.adjudicator.adjudicate(...)`.
- **Direct mutation.** No domain service may mutate without an
  IntentEnvelope. The legacy `with-adjudicate.ts` wrapper is deleted
  (pending C-09 in CUTOVER-STATUS.md); use `capsule.adjudicator` instead.

If a future adopter needs cognitive-loop variations, they belong in
**claustrum** — not in the adopter.
