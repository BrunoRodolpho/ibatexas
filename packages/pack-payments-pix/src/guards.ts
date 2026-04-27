/**
 * @adjudicate/pack-payments-pix — reusable guard factories.
 *
 * Some adopters route PIX through the Pack's intent kinds directly
 * (`pix.charge.confirm` arrives via webhook, the kernel adjudicates).
 * Others (notably IbateXas) wrap PIX in a higher-level intent like
 * `order.confirm` because the LLM operates one tier up. Both styles
 * need the same DEFER-on-pending-PIX guard logic.
 *
 * The factories here are extracted so the Pack's `policyBundle` and an
 * adopter's bespoke bundle can share the same DEFER semantics without
 * duplication. The Pack itself uses them to compose
 * `pixPaymentsPolicyBundle` (see `policies.ts`).
 *
 * This file is the load-bearing extension point for IbateXas migration:
 * `packages/llm-provider/src/order-policy-bundle.ts` calls
 * `createPixPendingDeferGuard` to replace what was previously inline.
 */

import {
  basis,
  BASIS_CODES,
  decisionDefer,
} from "@adjudicate/core";
import type { Guard } from "@adjudicate/core/kernel";
import {
  PIX_CONFIRMATION_SIGNAL,
  PIX_DEFAULT_DEFER_TIMEOUT_MS,
} from "./types.js";

/**
 * Generic "is the payment for this state PIX, and is it not yet
 * settled?" predicate. The factory is intentionally state-shape agnostic
 * — adopters supply two readers and an intent-kind matcher to plug it
 * into their own state.
 */
export interface PixPendingDeferGuardOptions<S> {
  /** Returns the state's payment-method label, or null when not applicable. */
  readonly readPaymentMethod: (state: S) => string | null | undefined;
  /** Returns the provider/internal payment status. */
  readonly readPaymentStatus: (state: S) => string | null | undefined;
  /**
   * Returns true if the envelope's intent kind triggers the PIX-pending
   * check. Defaults to matching `pix.charge.confirm`.
   */
  readonly matchesIntent?: (kind: string) => boolean;
  /** PIX-method label match (defaults to `"pix"`). */
  readonly pixMethodLabel?: string;
  /** Status values that count as settled (DEFER skipped). */
  readonly confirmedStatuses?: ReadonlySet<string>;
  /** Override the wire signal name; defaults to `PIX_CONFIRMATION_SIGNAL`. */
  readonly signal?: string;
  /** Override the DEFER timeout; defaults to `PIX_DEFAULT_DEFER_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** Default settled-status set for PIX. */
const DEFAULT_CONFIRMED: ReadonlySet<string> = new Set([
  "confirmed",
  "captured",
  "paid",
]);

/**
 * Build a Guard that DEFERs when an intent targets a PIX charge that
 * hasn't settled yet. The kernel parks the envelope; a webhook
 * subscriber later calls `resumeDeferredIntent` from
 * `@adjudicate/runtime` with the matching signal to re-enter
 * adjudication once the provider confirms.
 */
export function createPixPendingDeferGuard<S>(
  options: PixPendingDeferGuardOptions<S>,
): Guard<string, unknown, S> {
  const matches =
    options.matchesIntent ?? ((kind) => kind === "pix.charge.confirm");
  const pixLabel = options.pixMethodLabel ?? "pix";
  const confirmed = options.confirmedStatuses ?? DEFAULT_CONFIRMED;
  const signal = options.signal ?? PIX_CONFIRMATION_SIGNAL;
  const timeoutMs = options.timeoutMs ?? PIX_DEFAULT_DEFER_TIMEOUT_MS;

  return (envelope, state) => {
    if (!matches(envelope.kind)) return null;
    const method = options.readPaymentMethod(state);
    if (method !== pixLabel) return null;
    const status = options.readPaymentStatus(state);
    if (status && confirmed.has(status)) return null;
    return decisionDefer(signal, timeoutMs, [
      basis("state", BASIS_CODES.state.TRANSITION_VALID, {
        reason: "pix_pending",
        waitFor: signal,
        timeoutMs,
      }),
    ]);
  };
}
