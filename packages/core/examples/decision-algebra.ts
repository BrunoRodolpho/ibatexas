/**
 * Example: building decisions with the 6-valued algebra.
 * Run with `pnpm tsx examples/decision-algebra.ts` inside the package.
 */

import {
  basis,
  BASIS_CODES,
  buildEnvelope,
  decisionDefer,
  decisionEscalate,
  decisionExecute,
  decisionRefuse,
  decisionRequestConfirmation,
  decisionRewrite,
  refuse,
} from "../src/index.js";

const envelope = buildEnvelope({
  kind: "order.tool.propose",
  payload: { toolName: "add_item", input: { sku: "COSTELA", quantity: 1 } },
  actor: { principal: "llm", sessionId: "s-1" },
  taint: "UNTRUSTED",
  createdAt: "2026-04-23T12:00:00.000Z",
});

console.log("EXECUTE:");
console.log(
  decisionExecute([
    basis("state", BASIS_CODES.state.TRANSITION_VALID),
    basis("auth", BASIS_CODES.auth.SCOPE_SUFFICIENT),
    basis("taint", BASIS_CODES.taint.LEVEL_PERMITTED),
  ]),
);

console.log("\nREFUSE:");
console.log(
  decisionRefuse(
    refuse(
      "STATE",
      "order.already_shipped",
      "Seu pedido já foi enviado — não é mais possível cancelar.",
    ),
    [basis("state", BASIS_CODES.state.TERMINAL_STATE)],
  ),
);

console.log("\nESCALATE:");
console.log(
  decisionEscalate("human", "PIX CPF validation ambiguous", [
    basis("validation", BASIS_CODES.validation.HOMOGLYPH_NORMALIZED),
  ]),
);

console.log("\nREQUEST_CONFIRMATION:");
console.log(
  decisionRequestConfirmation(
    "Você pediu 10 kg de costela. Confirma essa quantidade?",
    [basis("business", BASIS_CODES.business.RULE_SATISFIED)],
  ),
);

console.log("\nDEFER:");
console.log(
  decisionDefer("payment.confirmed", 15 * 60 * 1000, [
    basis("state", BASIS_CODES.state.TRANSITION_VALID),
  ]),
);

console.log("\nREWRITE (sanitization — strip untrusted text from a trusted field):");
console.log(
  decisionRewrite(
    buildEnvelope({
      kind: envelope.kind,
      payload: { toolName: "add_item", input: { sku: "COSTELA", quantity: 1 } },
      actor: envelope.actor,
      taint: "TRUSTED",
      createdAt: envelope.createdAt,
    }),
    "user note removed from sensitive field",
    [basis("validation", BASIS_CODES.validation.UNICODE_NORMALIZED)],
  ),
);
