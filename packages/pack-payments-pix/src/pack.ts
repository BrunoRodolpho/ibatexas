/**
 * @adjudicate/pack-payments-pix — Pack composition.
 *
 * Wires the policy bundle, capability planner, and tool classification
 * into a single `PackV0` value. Adopters consume this directly:
 *
 * ```ts
 * import { pixPaymentsPack } from "@adjudicate/pack-payments-pix";
 * import { adjudicate } from "@adjudicate/core/kernel";
 *
 * const decision = adjudicate(envelope, state, pixPaymentsPack.policyBundle);
 * ```
 *
 * The `intentKinds` declared in metadata are the stable contract for
 * AaC review and replay tooling. Bumping them is a major-version change.
 */

import type { PackV0 } from "@adjudicate/core";
import { pixPaymentsCapabilityPlanner, PIX_PAYMENTS_TOOLS } from "./capabilities.js";
import { pixPaymentsPolicyBundle } from "./policies.js";
import {
  PIX_CHARGE_INTENT_KINDS,
  type PixChargeIntentKind,
  type PixChargeState,
} from "./types.js";

export const pixPaymentsPack: PackV0<
  PixChargeIntentKind,
  unknown,
  PixChargeState
> = {
  metadata: {
    name: "@adjudicate/pack-payments-pix",
    version: "0.1.0-experimental",
    intentKinds: PIX_CHARGE_INTENT_KINDS,
    summary:
      "PIX (Brazilian instant-payment) charge lifecycle Pack: create, confirm via webhook DEFER, refund.",
  },
  policyBundle: pixPaymentsPolicyBundle,
  capabilityPlanner: pixPaymentsCapabilityPlanner,
  toolClassification: PIX_PAYMENTS_TOOLS,
};
