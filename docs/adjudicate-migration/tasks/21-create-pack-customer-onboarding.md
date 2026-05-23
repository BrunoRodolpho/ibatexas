# Task 21 — Create `@ibatexas/pack-customer-onboarding`

**Milestone:** M2 (Pack architecture)
**Estimated effort:** M — 3–4 dev-days
**Blocks:** 14 (customer mutation routes — needs `customer.anonymize` + `customer.anonymize.cancel` policy), 15 (CustomerCommandService chokepoint)
**Blocked by:** 08 (pack-orders is the template; need its conformance pattern proven first)
**Owner:** unassigned

## Objective

Author the first-party `@ibatexas/pack-customer-onboarding` package covering the customer identity lifecycle: account creation, profile updates, sensitive-data saves (PIX details, addresses), preferences (allergens — safety-critical), and the LGPD Art. 18 anonymization flow with 24h grace period via DEFER.

After this lands, every customer-identity mutation in IbateXas adjudicates against this pack. It owns the destructive flow that task 14 consumes via HTTP routes.

Out of scope (separate concerns, NOT in this pack):
- `customer.session.*` — authentication/JWT lifecycle (future pack-auth or stays out)
- `customer.loyalty.*` — loyalty/redemption (future pack-loyalty)
- `customer.welcome_credit.grant` — promotional credit (future pack-promotions)

## Architecture context

Cite: investigation 05 §"Packs ibatexas should write", governance/01-intent-taxonomy.md §"customer" domain, governance/04-decision-policy.md §"DEFER semantics", investigation 08 P0 #2 (LGPD anonymize gap).

> Per master plan §"Workstream WS4 — Pack architecture": "Migrate `order-policy-bundle.ts` into `@ibatexas/pack-orders`. Author `@ibatexas/pack-reservations`, `@ibatexas/pack-whatsapp`, `@ibatexas/pack-customer-onboarding`."

This pack is the **destructive-flow lighthouse** for the migration: `customer.anonymize` is irreversible by definition; its DEFER + 24h grace + cancel-intent pattern is the canonical reference for any future destructive operation (e.g. order force-cancel, payment refund above threshold) that adopts the same UX.

The OTP gate, parking, and grace resolver live in **task 14** (route + subscriber layer). This task provides only the policy bundle.

## Files involved

**Read:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/domain/src/services/customer.service.ts` (existing identity logic, especially `anonymizeCustomer` at `:233-251`, `upsertFromPhone` at `:18`, `upsertFromWhatsApp` at `:172`, `updatePixDetails` at `:148`, `:49` preferences upsert)
- `/Users/thaisrodolpho/projects/ibatexas/packages/tools/src/intelligence/update-preferences.ts` (existing tool)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-orders/` (Task 08's pack — use as template)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-reservations/` (Task 09's pack — second reference for the template pattern)
- `/Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/*.ts` (canonical reference — note the DEFER signal pattern in `createPixPendingDeferGuard`)
- `/Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/governance/01-intent-taxonomy.md` (`customer` domain row authoritative for shapes)
- `/Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/governance/04-decision-policy.md` (DEFER + REQUEST_CONFIRMATION patterns)

**Create:**
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/package.json`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/tsconfig.json`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/index.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/types.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/policies.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/capabilities.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/refusals.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/signals.ts` (exports `CUSTOMER_ANONYMIZE_GRACE_SIGNAL = "customer.anonymize.confirmed_after_grace"` plus future signals)
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/__tests__/customer-onboarding-pack.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/__tests__/conformance.test.ts`
- `/Users/thaisrodolpho/projects/ibatexas/packages/pack-customer-onboarding/src/__tests__/lgpd-anonymize.test.ts` (dedicated suite for the destructive flow)

**Modify:**
- `/Users/thaisrodolpho/projects/ibatexas/apps/api/src/plugins/kernel-bootstrap.ts` — `installPack(customerOnboardingPack)` alongside `ordersPack`, `reservationsPack`
- `/Users/thaisrodolpho/projects/ibatexas/packages/llm-provider/package.json` — depend on `@ibatexas/pack-customer-onboarding`
- `/Users/thaisrodolpho/projects/ibatexas/.env.example` — add `CUSTOMER_ANONYMIZE_GRACE_HOURS=24` (default), `CUSTOMER_PROFILE_RATE_LIMIT_HOURS=1` (rate cap on profile updates to deter takeover)

## Constraints

- Must follow `@ibatexas/pack-orders` (Task 08) and `@ibatexas/pack-reservations` (Task 09) layouts.
- Must use the same primitives/guards convention as the other packs.
- pt-BR for all user-facing refusal text and confirmation prompts (CLAUDE.md rule #4).
- Allergen handling is **safety-critical** — `customer.preferences.update` MUST enforce an explicit array (CLAUDE.md rule #1); inferred allergens from name/description are REFUSE.
- PIX details (`customer.pix.details.save`) contain PII (name, email, CPF) — the policy itself does not touch raw PII; the **AuditRedactor** (task 18) hashes/redacts before the audit sink.
- `customer.anonymize` MUST return `decisionDefer({signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL, timeoutMs: env(CUSTOMER_ANONYMIZE_GRACE_HOURS) * 3600 * 1000})`.
- `customer.anonymize.cancel` MUST refuse a parked anonymize by checking `rk('anonymize:pending:{customerId}')`. If no parked deletion: REFUSE with basis `no_parked_deletion`.
- `customer.create` is `system`-only (no customer or staff can create their own account via the kernel — OTP flow seeds it).
- TypeScript strict, ESM, `.js` extensions on local imports.
- Follow CLAUDE.md rule #9 — these intents are reachable from the LLM tool path AND from HTTP routes; the pack is the single authority.

## Implementation requirements

### 1. Package scaffold (mirror pack-reservations exactly)

```jsonc
// packages/pack-customer-onboarding/package.json
{
  "name": "@ibatexas/pack-customer-onboarding",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": "./dist/index.js",
    "./signals": "./dist/signals.js",
    "./types": "./dist/types.js"
  },
  "dependencies": {
    "@adjudicate/core": "workspace:*",
    "@adjudicate/primitives": "workspace:*",
    "@adjudicate/runtime": "workspace:*"
  }
}
```

### 2. `types.ts`

```ts
export type CustomerOnboardingIntentKind =
  | "customer.create"
  | "customer.profile.update"
  | "customer.preferences.update"
  | "customer.pix.details.save"
  | "customer.address.add"
  | "customer.address.remove"
  | "customer.anonymize"
  | "customer.anonymize.cancel";

export interface CustomerOnboardingPayloads {
  "customer.create":            { phoneHash: string; source: "otp" | "wa-auto" };
  "customer.profile.update":    { name?: string; email?: string };
  "customer.preferences.update": { allergenExclusions: readonly string[]; dietaryFlags?: readonly string[] };
  "customer.pix.details.save":  { name: string; email: string; cpf: string };
  "customer.address.add":       { address: AddressPayload };
  "customer.address.remove":    { addressId: string };
  "customer.anonymize":         { customerId: string; otpToken: string; scope: "lgpd_art_18" };
  "customer.anonymize.cancel":  { customerId: string };
}

export interface CustomerOnboardingState {
  customerId?: string;
  customerExists: boolean;
  hasParkedAnonymize: boolean;
  parkedAnonymizeAt?: number;
  lastProfileUpdateAt?: number;
  isAuthenticated: boolean;
  otpFresh: boolean;          // <300s since OTP verification
}

export interface CustomerOnboardingContext {
  actor: { principal: "user" | "system" | "staff"; id?: string };
  redisRk: (template: string, ...args: string[]) => string;  // for receipt lookups
}
```

### 3. `signals.ts`

```ts
export const CUSTOMER_ANONYMIZE_GRACE_SIGNAL =
  "customer.anonymize.confirmed_after_grace" as const;

export type CustomerOnboardingSignal = typeof CUSTOMER_ANONYMIZE_GRACE_SIGNAL;
```

### 4. `policies.ts` — the heart of the pack

**State guards:**
- `customerMustExist` — REFUSE if `state.customerExists === false` for any kind except `customer.create`.
- `customerMustBeAuthenticated` — REFUSE if `state.isAuthenticated === false` for customer-actor kinds.
- `otpMustBeFresh` — REFUSE if `state.otpFresh === false` for `customer.anonymize` and `customer.anonymize.cancel`.

**Auth guards:**
- `customer.create` is `system`-only (taint policy enforces).
- `customer.profile.update`, `customer.preferences.update`, `customer.pix.details.save`, `customer.address.*`, `customer.anonymize`, `customer.anonymize.cancel` require `customer`-actor with matching `customerId`.

**Taint:**
```ts
createSystemTaintPolicy({
  systemOnlyKinds: new Set(["customer.create"]),
  userMinimum: "UNTRUSTED",
  systemMinimum: "SYSTEM",
});
```

**Business guards (kind-specific):**

1. **`customer.preferences.update` — explicit-array guard.** REFUSE if `payload.allergenExclusions` is not an explicit array (e.g. inferred from prose). CLAUDE.md rule #1 enforcement. Basis: `policy.allergens.must_be_explicit`.

2. **`customer.profile.update` — rate-limit guard.** REFUSE if `state.lastProfileUpdateAt` is within `CUSTOMER_PROFILE_RATE_LIMIT_HOURS` (default 1). Basis: `policy.profile.rate_limit`. Counters takeover-via-rapid-update.

3. **`customer.anonymize` — DEFER + grace guard.**
    ```ts
    decisionDefer({
      signal: CUSTOMER_ANONYMIZE_GRACE_SIGNAL,
      timeoutMs: getGraceHours() * 3600 * 1000,
      basis: [basis("policy", "lgpd_art_18_grace")],
      userFacing: "Pedido de exclusão recebido. Você tem 24 horas para cancelar.",
    });
    ```
    Pre-conditions before DEFER:
    - `state.otpFresh === true` (else REFUSE)
    - `state.hasParkedAnonymize === false` (else REFUSE — already pending, idempotency)

4. **`customer.anonymize.cancel` — REFUSEs parked deletion.**
    - If `state.hasParkedAnonymize === false`: REFUSE with basis `no_parked_deletion`, userFacing "Não há solicitação de exclusão pendente."
    - If `state.hasParkedAnonymize === true`: return `decisionRefuse(...)` with basis `policy.cancel_supersedes_parked`. The HTTP route layer (task 14) consumes this decision by clearing the Redis receipt; the audit record links via `supersedes: [parked.intentHash]` (set by the route, not the guard).

5. **`customer.address.remove` — auth+ownership guard.** Already covered by `customerMustBeAuthenticated` + actor-id check; no extra business guard.

6. **`customer.pix.details.save` — payload-shape guard.** Verify CPF format (11 digits, valid checksum). REFUSE if invalid. Basis: `policy.cpf.invalid_format`. Note: the audit redactor (task 18) is responsible for nuking the CPF before sink; the policy only validates shape.

**Default:**
```ts
constant(decisionRefuse(
  refuse("policy", "default_deny", "Essa ação não é permitida neste momento."),
  [basis("kernel", "default_deny" as any)]
))
```

### 5. `capabilities.ts`

```ts
export const customerOnboardingCapabilityPlanner: CapabilityPlanner = { /* TBD */ };
export const customerOnboardingToolClassification: ToolClassification = {
  "update_preferences": "MUTATING",
  "save_pix_details": "MUTATING",
  // anonymize is NOT LLM-callable; HTTP-only via task 14
};
```

### 6. `refusals.ts` — pt-BR typed helpers

```ts
export const refuseAllergenInferred = () =>
  refuse("policy", "allergens.must_be_explicit",
    "Por segurança, alergias precisam ser informadas explicitamente.");

export const refuseProfileRateLimit = (hoursRemaining: number) =>
  refuse("policy", "profile.rate_limit",
    `Aguarde ${hoursRemaining}h antes de atualizar seu perfil novamente.`);

export const refuseOtpStale = () =>
  refuse("policy", "otp.stale",
    "Sua verificação expirou. Solicite um novo código.");

export const refuseAnonymizeAlreadyPending = () =>
  refuse("policy", "anonymize.already_pending",
    "Já existe uma solicitação de exclusão em andamento.");

export const refuseAnonymizeNoParkedDeletion = () =>
  refuse("policy", "anonymize.no_parked_deletion",
    "Não há solicitação de exclusão pendente.");

export const refuseCpfInvalid = () =>
  refuse("policy", "cpf.invalid_format",
    "CPF inválido. Verifique e tente novamente.");
```

### 7. `index.ts`

```ts
export const customerOnboardingPack: PackV0<
  CustomerOnboardingIntentKind,
  CustomerOnboardingPayloads,
  CustomerOnboardingState,
  CustomerOnboardingContext
> = {
  id: "ibatexas.pack-customer-onboarding",
  version: "0.1.0",
  policy: customerOnboardingPolicyBundle,
  conformance: customerOnboardingConformanceCorpus,
  rehydrate: customerOnboardingRehydrator,
};

export * from "./types.js";
export * from "./signals.js";
```

### 8. Conformance corpus (~28 fixtures, 6 outcomes × relevant kinds)

Required cases:
- `customer.anonymize` happy DEFER (otpFresh=true, hasParkedAnonymize=false)
- `customer.anonymize` REFUSE — stale OTP
- `customer.anonymize` REFUSE — already pending
- `customer.anonymize.cancel` REFUSE — no parked deletion
- `customer.anonymize.cancel` REFUSE-supersedes-parked — happy path
- `customer.preferences.update` REFUSE — non-array allergenExclusions
- `customer.preferences.update` EXECUTE — empty array `[]`
- `customer.profile.update` EXECUTE — first update
- `customer.profile.update` REFUSE — rate-limited
- `customer.pix.details.save` REFUSE — invalid CPF
- `customer.pix.details.save` EXECUTE — valid CPF
- `customer.create` EXECUTE — system actor
- `customer.create` REFUSE — customer actor (taint)
- `customer.address.add` EXECUTE
- `customer.address.remove` EXECUTE
- Default REFUSE for unknown kind

### 9. `lgpd-anonymize.test.ts` (dedicated)

Reproduce the full lifecycle as policy-level fixtures:
1. T0: `customer.anonymize` with fresh OTP → DEFER {signal, timeoutMs}
2. T+1h: `customer.anonymize.cancel` with `hasParkedAnonymize=true` → REFUSE with `supersedes_parked` basis
3. T+1h: re-issue `customer.anonymize` (after cancel) → DEFER again (idempotent re-park OK)
4. T+24h+1ms: ledger should consider parked DEFER expired (test triggered via state, not real clock); the actual sweeper lives in task 03/14 — this test only verifies the *policy* still returns DEFER for a fresh re-issue

### 10. Wire at boot

In `apps/api/src/plugins/kernel-bootstrap.ts`:

```ts
import { customerOnboardingPack } from "@ibatexas/pack-customer-onboarding";
// ...
installPack(customerOnboardingPack, { onConformanceFailure: "warn" });
```

### 11. `.env.example`

```
# Customer onboarding pack
CUSTOMER_ANONYMIZE_GRACE_HOURS=24
CUSTOMER_PROFILE_RATE_LIMIT_HOURS=1
```

## Acceptance criteria

- [ ] `@ibatexas/pack-customer-onboarding` package exists with all 8 source files + 3 test files.
- [ ] `customerOnboardingPack` satisfies `PackV0`.
- [ ] `installPack(customerOnboardingPack)` succeeds at boot.
- [ ] Conformance corpus (~28 cases) passes.
- [ ] `runConformance(customerOnboardingPack)` returns zero failures.
- [ ] LGPD anonymize test suite covers DEFER, cancel, re-issue, idempotency.
- [ ] All 6 typed refusal helpers in pt-BR.
- [ ] `customerOnboardingPack.policy.default.kind === "REFUSE"`.
- [ ] Two new env vars documented in `.env.example`.
- [ ] `CUSTOMER_ANONYMIZE_GRACE_SIGNAL` exported from `./signals` subpath.
- [ ] `pnpm typecheck` workspace-wide passes.

## Testing requirements

- **Unit:** `customer-onboarding-pack.test.ts` + `conformance.test.ts` + `lgpd-anonymize.test.ts`.
- **Integration:** N/A at this stage — Task 14 wires the pack into the HTTP layer; Task 15 wires it into `CustomerCommandService`.
- **Bypass-detection:** the default-REFUSE assertion above; plus a static-analysis hook in task 20 will verify no Prisma write against the `Customer` model occurs outside an `adjudicate() === EXECUTE` branch.

## Rollout notes

Direct merge. The pack is installed but no intent kinds are added to `IBX_KERNEL_SHADOW` or `IBX_KERNEL_ENFORCE` yet. Behavioural change = zero until task 14 lands routes that build envelopes for these kinds AND the rollout milestone M5 adds them to shadow.

Per migration/04-shadow-enforce-sequencing.md, the order is:
- `customer.preferences.update`, `customer.profile.update` — Tier 1 (low risk, enforce first)
- `customer.address.*`, `customer.pix.details.save` — Tier 2
- `customer.anonymize`, `customer.anonymize.cancel` — Tier 4 (28-day shadow, legal sign-off, last to enforce)

## Rollback notes

Revert the PR. The pack disappears, `installPack` call is removed. If task 14 has already shipped and is producing `customer.anonymize` envelopes, those envelopes will hit the default-REFUSE path (since no pack covers them) — customer-visible impact: anonymize requests refuse with "ação não permitida" until task 21 is re-merged or task 14 is reverted in tandem. ETA: 5 min for hard rollback. Coordinate with task 14 owner before reverting.

---

## Sub-agent prompt

```
You are an implementation agent for ibatexas task 21: create @ibatexas/pack-customer-onboarding.

CONTEXT
Per investigation 05 (§"Packs ibatexas should write") and master plan §WS4 in /Users/thaisrodolpho/projects/ibatexas/docs/adjudicate-migration/, IbateXas needs first-party Packs. Tasks 08 (pack-orders) and 09 (pack-reservations) established the template. Your job: follow the same template to create pack-customer-onboarding, which owns the customer identity lifecycle including the LGPD Art. 18 anonymize flow with 24h grace via DEFER (consumed by task 14's HTTP routes).

REPO LAYOUT
- packages/pack-orders/, packages/pack-reservations/ — sibling references (follow their structure exactly)
- /Users/thaisrodolpho/projects/adjudicate/packages/pack-payments-pix/src/*.ts — canonical reference for the DEFER signal pattern
- packages/domain/src/services/customer.service.ts — source of existing identity logic (anonymizeCustomer at :233-251, upsertFromPhone at :18, updatePixDetails at :148)
- packages/tools/src/intelligence/update-preferences.ts — existing LLM tool for preferences
- @adjudicate/primitives exports: createSystemTaintPolicy, basis, refuse, decisionRefuse, decisionDefer

SCOPE — DO NOT MODIFY FILES OUTSIDE THIS LIST
- packages/pack-customer-onboarding/package.json (CREATE)
- packages/pack-customer-onboarding/tsconfig.json (CREATE)
- packages/pack-customer-onboarding/src/index.ts (CREATE)
- packages/pack-customer-onboarding/src/types.ts (CREATE)
- packages/pack-customer-onboarding/src/signals.ts (CREATE)
- packages/pack-customer-onboarding/src/policies.ts (CREATE)
- packages/pack-customer-onboarding/src/capabilities.ts (CREATE)
- packages/pack-customer-onboarding/src/refusals.ts (CREATE)
- packages/pack-customer-onboarding/src/__tests__/customer-onboarding-pack.test.ts (CREATE)
- packages/pack-customer-onboarding/src/__tests__/conformance.test.ts (CREATE)
- packages/pack-customer-onboarding/src/__tests__/lgpd-anonymize.test.ts (CREATE)
- apps/api/src/plugins/kernel-bootstrap.ts (MODIFY — installPack(customerOnboardingPack))
- packages/llm-provider/package.json (MODIFY — add @ibatexas/pack-customer-onboarding dep)
- .env.example (MODIFY — add 2 customer-onboarding env vars)

INTENT KINDS THIS PACK OWNS (8 total)
- customer.create (system actor only)
- customer.profile.update
- customer.preferences.update
- customer.pix.details.save
- customer.address.add
- customer.address.remove
- customer.anonymize       ← DEFER with signal "customer.anonymize.confirmed_after_grace"
- customer.anonymize.cancel ← REFUSE the parked anonymize

EXPLICITLY OUT OF SCOPE
- customer.session.* (auth flow)
- customer.loyalty.*
- customer.welcome_credit.grant

KEY BUSINESS RULES
1. customer.preferences.update — REFUSE if allergenExclusions is not an explicit array (CLAUDE.md rule #1). Empty array [] is fine.
2. customer.profile.update — REFUSE if updated within CUSTOMER_PROFILE_RATE_LIMIT_HOURS (default 1).
3. customer.pix.details.save — REFUSE on invalid CPF (11 digits + checksum).
4. customer.anonymize — REFUSE if OTP stale (otpFresh=false) or hasParkedAnonymize=true; else DEFER with grace signal and 24h timeout.
5. customer.anonymize.cancel — REFUSE the parked anonymize (basis: cancel_supersedes_parked) or REFUSE no_parked_deletion if nothing pending.
6. customer.create is system-only via createSystemTaintPolicy({systemOnlyKinds: new Set(["customer.create"]), userMinimum: "UNTRUSTED", systemMinimum: "SYSTEM"}).

WHAT TO BUILD

1. package.json mirrors pack-reservations structure with name "@ibatexas/pack-customer-onboarding"; exports "./signals" and "./types" subpaths.

2. types.ts: CustomerOnboardingIntentKind union of the 8 kinds, CustomerOnboardingPayloads map, CustomerOnboardingState (customerExists, hasParkedAnonymize, parkedAnonymizeAt, lastProfileUpdateAt, isAuthenticated, otpFresh), CustomerOnboardingContext.

3. signals.ts: export CUSTOMER_ANONYMIZE_GRACE_SIGNAL = "customer.anonymize.confirmed_after_grace" as const.

4. policies.ts — build customerOnboardingPolicyBundle:
   - State guards: customerMustExist (skip for customer.create), customerMustBeAuthenticated, otpMustBeFresh (only for anonymize + cancel)
   - Auth guards: actor-id match for customer-actor kinds
   - Taint: createSystemTaintPolicy with customer.create as system-only
   - Business guards (in this order, first match wins per kind):
     * customer.preferences.update: explicit-array guard for allergenExclusions
     * customer.profile.update: rate-limit guard
     * customer.anonymize: DEFER guard with CUSTOMER_ANONYMIZE_GRACE_SIGNAL, env-configured timeout, and pre-conditions (otpFresh + !hasParkedAnonymize)
     * customer.anonymize.cancel: refuse-supersedes-parked or refuse-no-parked-deletion
     * customer.pix.details.save: CPF-shape guard
   - Default: decisionRefuse with pt-BR "Essa ação não é permitida neste momento."

5. capabilities.ts: customerOnboardingCapabilityPlanner + customerOnboardingToolClassification (LLM-callable: update_preferences=MUTATING, save_pix_details=MUTATING; anonymize is NOT LLM-callable).

6. refusals.ts: 6 typed pt-BR refusal helpers (refuseAllergenInferred, refuseProfileRateLimit, refuseOtpStale, refuseAnonymizeAlreadyPending, refuseAnonymizeNoParkedDeletion, refuseCpfInvalid).

7. index.ts: export customerOnboardingPack: PackV0<...> and re-export types + signals.

8. Conformance corpus (~28 fixtures covering DEFER, REFUSE variants, EXECUTE happy paths, and default refuse).

9. lgpd-anonymize.test.ts: dedicated LGPD lifecycle suite (anonymize→DEFER, cancel→REFUSE-supersedes, re-issue→DEFER, idempotency).

10. kernel-bootstrap.ts: import customerOnboardingPack, call installPack(customerOnboardingPack, {onConformanceFailure: "warn"}).

11. .env.example: append under existing Adjudicate Kernel stanza:
    CUSTOMER_ANONYMIZE_GRACE_HOURS=24
    CUSTOMER_PROFILE_RATE_LIMIT_HOURS=1

CONSTRAINTS
- Read CLAUDE.md rules 1, 4, 5, 7, 9 first
- pt-BR for all user-facing refusal text
- Allergens MUST be explicit array (rule #1); inferred → REFUSE
- TypeScript strict, ESM, .js extensions on local imports
- DO NOT modify packages/domain or packages/tools — Task 15 owns command-service refactor
- DO NOT modify @adjudicate/* source
- The pack does NOT touch raw PII in payloads (CPF/email/phone are validated for shape, not redacted; task 18's AuditRedactor handles redaction)

ACCEPTANCE CHECKLIST (verify before returning)
- [ ] Package scaffold matches pack-reservations layout
- [ ] customerOnboardingPack satisfies PackV0
- [ ] installPack(customerOnboardingPack) succeeds at boot
- [ ] Conformance corpus (~28 cases) passes
- [ ] LGPD anonymize test suite covers DEFER, cancel, re-issue
- [ ] 6 typed refusal helpers in pt-BR
- [ ] Default decision is REFUSE
- [ ] Two new env vars in .env.example
- [ ] CUSTOMER_ANONYMIZE_GRACE_SIGNAL exported via ./signals subpath
- [ ] pnpm typecheck workspace-wide passes

When complete, return: files created/modified, conformance corpus size, any deviations from pack-reservations structure, and any open design questions about LGPD edge cases (e.g. customer-initiated re-park within minutes of cancel).
```
