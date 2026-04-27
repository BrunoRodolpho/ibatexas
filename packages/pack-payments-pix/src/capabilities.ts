/**
 * @adjudicate/pack-payments-pix — capability planner & tool classification.
 *
 * The Pack ships only the **mutating-tool** intent kinds (`pix.charge.*`).
 * Adopters layer their own READ_ONLY tools (e.g. `view_pix_status`,
 * `download_qr`) on top because the read surface depends on the host
 * application's data model.
 *
 * The planner is intentionally state-driven: the visible intent set
 * shrinks as the charge progresses, so the LLM can never propose a
 * mutation that's structurally illegal at the current stage.
 */

import {
  filterReadOnly,
  type CapabilityPlanner,
  type Plan,
  type ToolClassification,
} from "@adjudicate/core/llm";
import type {
  PixChargeIntentKind,
  PixChargeState,
  PixChargeStatus,
} from "./types.js";

/**
 * Tool partition. The Pack does not expose any READ_ONLY tools by
 * default — adopters compose their own READ surface. MUTATING entries
 * mirror the intent kinds 1:1.
 */
export const PIX_PAYMENTS_TOOLS: ToolClassification = {
  READ_ONLY: new Set<string>(),
  MUTATING: new Set([
    "pix_charge_create",
    "pix_charge_confirm",
    "pix_charge_refund",
  ]),
};

/**
 * Per-status visible tool surface. Notes:
 *
 *   - Tools the LLM cannot propose are simply absent — `filterReadOnly`
 *     erases mutating tools structurally.
 *   - `pix_charge_confirm` is never visible to the LLM at any state.
 *     Its taint floor (TRUSTED) belongs to the webhook adapter only.
 *   - `pix_charge_refund` is only visible once a charge is captured;
 *     before that, refund is meaningless.
 */
const TOOLS_BY_STATUS: Record<PixChargeStatus | "none", ReadonlyArray<string>> = {
  none: ["pix_charge_create"],
  pending: [],
  confirmed: ["pix_charge_refund"],
  captured: ["pix_charge_refund"],
  expired: ["pix_charge_create"],
  failed: ["pix_charge_create"],
  partially_refunded: ["pix_charge_refund"],
  refunded: [],
};

const INTENTS_BY_STATUS: Record<
  PixChargeStatus | "none",
  ReadonlyArray<PixChargeIntentKind>
> = {
  none: ["pix.charge.create"],
  pending: [],
  confirmed: ["pix.charge.refund"],
  captured: ["pix.charge.refund"],
  expired: ["pix.charge.create"],
  failed: ["pix.charge.create"],
  partially_refunded: ["pix.charge.refund"],
  refunded: [],
};

export const pixPaymentsCapabilityPlanner: CapabilityPlanner<PixChargeState> = {
  plan(state): Plan {
    const status: PixChargeStatus | "none" = state.charge?.status ?? "none";
    const allTools = TOOLS_BY_STATUS[status] ?? [];
    return {
      visibleReadTools: filterReadOnly(PIX_PAYMENTS_TOOLS, allTools),
      allowedIntents: INTENTS_BY_STATUS[status] ?? [],
      forbiddenConcepts: [
        // Concepts the LLM must not assert at any point in the flow.
        "garantia de reembolso",
        "pagamento aprovado automaticamente",
        "PIX sem custos para o lojista",
      ],
    };
  },
};
