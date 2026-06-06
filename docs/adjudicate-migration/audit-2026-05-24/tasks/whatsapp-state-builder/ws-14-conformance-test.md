# WS-14 — Conformance test: state-builder adoption conformance

**Wave:** 3 (final assertion; runs after all WS-N sites migrate)
**Status:** GATED on stakeholder pick of open question 3.
**Design source:** [`docs/architecture/design/whatsapp-state-builder.md`](../../../../architecture/design/whatsapp-state-builder.md) §"Test fixtures + conformance" + §"Open questions" Q3.

---

## Objective

Add a conformance test (T8) that asserts every WhatsApp egress site uses `buildWhatsAppState()` rather than re-deriving the `lastCustomerMessageAt` projection inline. Static-analysis pass to catch any new site that adds direct `sendText()`/`sendMedia()` calls without going through the state-builder.

## Blocking design-doc picks

- **Q3 (Does `whatsapp-webhook.ts` agent-reply path migrate too?)** — recommended defer; **this task assumes deferred**. The conformance test allowlists `apps/api/src/routes/whatsapp-webhook.ts` as exempt (with an explanatory comment). If stakeholder later picks "migrate", remove the allowlist.

## Impacted files

- **NEW** [`apps/api/src/__tests__/conformance/whatsapp-state-builder-adoption.test.ts`](../../../../../apps/api/src/__tests__/conformance/) — the conformance test.
- **NEW** [`apps/api/src/__tests__/conformance/whatsapp-state-builder-exempt-sites.ts`](../../../../../apps/api/src/__tests__/conformance/) — the allowlist (only `whatsapp-webhook.ts` initially, plus the always-governed `apps/api/src/whatsapp/client.ts:sendText/sendMedia` which is the HTTP-egress wrapper, not a business-policy site).

## Dependencies

- **WS-1..12** all required (the conformance test asserts every site uses the helper; sites must already be migrated to pass).
- Independent of WS-13.

## Acceptance criteria

- The test:
  - Greps the API codebase for `sendText(` and `sendMedia(` call sites (excluding the helper module itself, the exempt allowlist, and test files).
  - For each match outside the allowlist, asserts the surrounding code imports `buildWhatsAppState` from `@/subscribers/__shared__/whatsapp-state-builder`.
  - Fails if a match exists without the import (catches: a new subscriber/job is added that calls `sendText` without state-building).
- The allowlist file documents:
  - `apps/api/src/whatsapp/client.ts` — the HTTP wrapper, exempt by architecture.
  - `apps/api/src/routes/whatsapp-webhook.ts` — the agent reply path, exempt per Q3 recommendation. With reference to the design doc's §"Deferred sites inventory" footnote.
- Test runs in CI; failures block merges.

## Test strategy

- The conformance test IS the test. It uses static file scanning (read + regex).
- A meta-test (vitest test of the conformance test) verifies:
  - Adding a fake `sendText` call to a non-exempt file causes the test to fail.
  - Adding a `sendText` call to an exempt file does NOT fail.
  - Adding the `buildWhatsAppState` import next to a `sendText` call passes.

## Rollout notes

- Land this LAST in the DAG, after all 9 sites are migrated. Otherwise it'll fail immediately.
- Once landed, every new PR that adds a WhatsApp send must use the state-builder (the test catches it).

## Rollback notes

- Removing the test doesn't change runtime behaviour — it's a CI gate, not a code path.

## Merge-conflict risk

- **LOW.** New test file; allowlist is a new module. No overlap with site migrations themselves.

## Ready-to-spawn sub-agent prompt

> You are the WS-14 sub-agent for the WhatsApp state-builder DAG.
>
> **Scope:** Add a conformance test that asserts every WhatsApp egress site uses `buildWhatsAppState()`. The test should fail in CI if a new direct-`sendText` callsite is added outside the allowlist.
>
> **Pre-reqs:** WS-1..12 all merged. Verify via git log: every site's commit landed.
>
> **Steps:**
> 1. Read `docs/architecture/design/whatsapp-state-builder.md` §"Test fixtures + conformance".
> 2. Read existing conformance tests for pattern (search `*-conformance.test.ts` or similar under `apps/api/src/__tests__/`).
> 3. Create the allowlist module at `apps/api/src/__tests__/conformance/whatsapp-state-builder-exempt-sites.ts`. Initial entries: `whatsapp/client.ts`, `routes/whatsapp-webhook.ts`.
> 4. Create the conformance test at `apps/api/src/__tests__/conformance/whatsapp-state-builder-adoption.test.ts`:
>    - Recursively read all `.ts` files under `apps/api/src/`.
>    - For each file containing `sendText(` or `sendMedia(` outside the allowlist, assert it imports `buildWhatsAppState`.
> 5. Add the meta-test asserting the conformance test itself behaves correctly.
> 6. Run the test → should pass (since all sites are migrated).
> 7. Intentionally break a site (revert one of WS-4..12's changes locally) → run test → should fail with a clear message. Re-apply the change.
>
> **Hard stops:**
> - If the test fails on first run, some site didn't fully migrate. STOP and report which site.
>
> **Commit:** `test(api,whatsapp-state-builder): conformance test for state-builder adoption (T8)`
>
> **Out of scope:** updating the allowlist for `whatsapp-webhook.ts` migration if/when Q3 flips. Future task.

## Estimated complexity

**S** — single conformance test + allowlist + meta-tests. ~3-5 hours.
