// BKL-215 — the customer-plane deterministic amend success render. Proves a
// committed amend renders a grounded success (not the 4B's live false-failure)
// and that non-amend / non-committed turns return undefined (byte-identical
// fall-through to the existing grounded model path).

import { describe, it, expect } from "vitest";
import { renderCustomerActionAnswer } from "../customer-action-render.js";

const executed = (kind: string, payload: unknown, result: unknown = { ok: true }) => ({
  kind: "executed",
  envelope: { kind, payload },
  result,
});

describe("renderCustomerActionAnswer — BKL-215 amend success (false-FAILURE fix)", () => {
  it("order.amend.add_item (qty 1) → grounded success, never an error line", () => {
    const text = renderCustomerActionAnswer(
      executed("order.amend.add_item", { orderId: "o1", variantId: "v1", quantity: 1, allergens: [] }),
    );
    expect(text).toBe("Pronto! Adicionei o item ao seu pedido.");
    expect(text).not.toMatch(/erro|falh|não consegu/i);
  });

  it("order.amend.add_item (qty > 1) → voices the grounded quantity from the payload", () => {
    expect(
      renderCustomerActionAnswer(
        executed("order.amend.add_item", { orderId: "o1", variantId: "v1", quantity: 3, allergens: [] }),
      ),
    ).toBe("Pronto! Adicionei 3 unidades ao seu pedido.");
  });

  it("order.amend.update_qty → grounded quantity update", () => {
    expect(
      renderCustomerActionAnswer(
        executed("order.amend.update_qty", { orderId: "o1", itemId: "i1", quantity: 2 }),
      ),
    ).toBe("Pronto! Atualizei a quantidade para 2 no seu pedido.");
  });

  it("order.amend.remove_item → grounded removal", () => {
    expect(
      renderCustomerActionAnswer(executed("order.amend.remove_item", { orderId: "o1", itemId: "i1" })),
    ).toBe("Pronto! Removi o item do seu pedido.");
  });

  it("a transactional plan of amends renders each in order, joined", () => {
    const text = renderCustomerActionAnswer({
      kind: "executed_plan",
      executions: [
        { envelope: { kind: "order.amend.add_item", payload: { quantity: 2 } }, result: {} },
        { envelope: { kind: "order.amend.remove_item", payload: {} }, result: {} },
      ],
    });
    expect(text).toBe("Pronto! Adicionei 2 unidades ao seu pedido.\n\nPronto! Removi o item do seu pedido.");
  });

  it("NEVER invents an item name or order number (grounded only in kind + quantity)", () => {
    const text = renderCustomerActionAnswer(
      executed("order.amend.add_item", { orderId: "order_abc", variantId: "variant_xyz", quantity: 1, allergens: [] }),
    )!;
    expect(text).not.toContain("order_abc");
    expect(text).not.toContain("variant_xyz");
    expect(text).not.toMatch(/#\d/); // no fabricated display number
  });
});

describe("renderCustomerActionAnswer — BKL-231 reservation.modify success", () => {
  it("reservation.modify with newPartySize → grounded 'alterada para N pessoas' (was NO reply on resume)", () => {
    const text = renderCustomerActionAnswer(
      executed("reservation.modify", { reservationId: "r1", newPartySize: 4 }),
    )!;
    expect(text).toBe("Pronto! Sua reserva foi alterada para 4 pessoas.");
  });

  it("reservation.modify newPartySize=1 → singular 'pessoa'", () => {
    const text = renderCustomerActionAnswer(
      executed("reservation.modify", { reservationId: "r1", newPartySize: 1 }),
    )!;
    expect(text).toBe("Pronto! Sua reserva foi alterada para 1 pessoa.");
  });

  it("reservation.modify time-only (newTimeSlotId, no party) → grounded generic, NO fabricated time", () => {
    const text = renderCustomerActionAnswer(
      executed("reservation.modify", { reservationId: "r1", newTimeSlotId: "slot_20h" }),
    )!;
    expect(text).toBe("Pronto! Sua reserva foi atualizada.");
    expect(text).not.toContain("slot_20h");
    expect(text).not.toMatch(/\d{1,2}h|\d{1,2}:\d{2}/); // never invents a clock time
  });
});

// ── BKL-230 — order.checkout.create, the OUTCOME-GROUNDED render ───────────────
//
// Checkout is the only kind here whose EXECUTE can commit at the kernel and still
// FAIL in the tool (createCheckout returns `success:false` on payment-init failure
// and on missing PIX name/email — it does not throw, so the dispatch is still
// `executed`). Every arm below is therefore an arm about the RESULT, not the
// payload: a success line may only appear when the executor proved success.
describe("renderCustomerActionAnswer — BKL-230 checkout success (truthfulness gate)", () => {
  const checkout = (result: unknown) =>
    executed("order.checkout.create", { cartId: "c1" }, result);

  const PIX_LINE =
    "Seu código PIX foi gerado! O pedido será confirmado assim que o pagamento for aprovado.";

  it("pix success → the QR line, and the order is NOT claimed as confirmed yet", () => {
    const text = renderCustomerActionAnswer(
      checkout({ success: true, paymentMethod: "pix", orderId: "pi_3QxyzABC123" }),
    )!;
    expect(text).toBe(PIX_LINE);
    // The confirmation is FUTURE/CONDITIONAL — never a settled-payment claim.
    expect(text).toMatch(/será confirmado assim que/);
    expect(text).not.toMatch(/pagamento (?:foi )?(?:aprovado|confirmado|recebido)\b/i);
  });

  it("pix success NEVER voices result.orderId (it is a Stripe pi_… PaymentIntent, not an order number)", () => {
    const text = renderCustomerActionAnswer(
      checkout({ success: true, paymentMethod: "pix", orderId: "pi_3QxyzABC123" }),
    )!;
    expect(text).not.toContain("pi_3QxyzABC123");
    expect(text).not.toContain("pi_");
    expect(text).not.toMatch(/IBX-\d/);
    expect(text).not.toMatch(/#\d/);
  });

  it("cash success → the order IS confirmed, voicing the IBX-#### display id", () => {
    const text = renderCustomerActionAnswer(
      checkout({ success: true, paymentMethod: "cash", orderId: "IBX-0042" }),
    )!;
    expect(text).toBe("Pronto! Seu pedido IBX-0042 foi confirmado.");
  });

  it("cash success claims nothing about the PAYMENT (cash is still pending) nor where it is paid", () => {
    const text = renderCustomerActionAnswer(
      checkout({ success: true, paymentMethod: "cash", orderId: "IBX-0042" }),
    )!;
    expect(text).not.toMatch(/pagamento/i);
    expect(text).not.toMatch(/entrega|retirada/i);
  });

  it("cash success with a RAW medusa order id → generic line, the internal id is never leaked", () => {
    // create-checkout falls back to the raw `order_…` id when the projection
    // carries no display_id; only the IBX-#### shape is customer-facing.
    const text = renderCustomerActionAnswer(
      checkout({ success: true, paymentMethod: "cash", orderId: "order_01JABCDEF" }),
    )!;
    expect(text).toBe("Pronto! Seu pedido foi confirmado.");
    expect(text).not.toContain("order_01JABCDEF");
  });

  it("cash success with NO orderId at all → generic line, no fabricated number", () => {
    expect(
      renderCustomerActionAnswer(checkout({ success: true, paymentMethod: "cash" })),
    ).toBe("Pronto! Seu pedido foi confirmado.");
  });

  // ── THE HARD CONSTRAINT: a failed tool call must never render a success ──
  it.each([
    [
      "payment-init failure (create-checkout.ts:573-580)",
      {
        success: false,
        paymentMethod: "pix",
        message:
          "Não foi possível inicializar o pagamento. Tente novamente ou escolha pagamento em dinheiro.",
      },
    ],
    [
      "missing PIX name/email (create-checkout.ts:598-605)",
      {
        success: false,
        paymentMethod: "pix",
        message: "Nome e email são obrigatórios para pagamento PIX.",
      },
    ],
    [
      "PIX QR generation error (keeps a pi_ reference)",
      { success: false, paymentMethod: "pix", orderId: "pi_3QxyzABC123" },
    ],
    ["cash failure", { success: false, paymentMethod: "cash", orderId: "IBX-0042" }],
  ])("success:false — %s → undefined (NO deterministic success line)", (_label, result) => {
    expect(renderCustomerActionAnswer(checkout(result))).toBeUndefined();
  });

  it("card → undefined (a client-secret handoff places nothing; existing behavior preserved)", () => {
    expect(
      renderCustomerActionAnswer(
        checkout({
          success: true,
          paymentMethod: "card",
          stripeClientSecret: "pi_3Q_secret_abc",
          paymentIntentId: "pi_3QxyzABC123",
        }),
      ),
    ).toBeUndefined();
  });

  it.each([
    ["an unknown payment method", { success: true, paymentMethod: "boleto" }],
    ["no paymentMethod at all", { success: true }],
    ["a non-boolean truthy success", { success: "true", paymentMethod: "pix" }],
    ["success:1 (truthy but not true)", { success: 1, paymentMethod: "pix" }],
    ["a null result", null],
    ["a string result", "ok"],
  ])("%s → undefined (only an explicit success===true earns a line)", (_label, result) => {
    expect(renderCustomerActionAnswer(checkout(result))).toBeUndefined();
  });

  it("a plan mixing a FAILED checkout with a committed amend renders ONLY the amend", () => {
    // The failed checkout must not borrow the amend's success, and must not
    // blank the reply either.
    const text = renderCustomerActionAnswer({
      kind: "executed_plan",
      executions: [
        {
          envelope: { kind: "order.checkout.create", payload: { cartId: "c1" } },
          result: { success: false, paymentMethod: "pix" },
        },
        {
          envelope: { kind: "order.amend.add_item", payload: { quantity: 1 } },
          result: {},
        },
      ],
    });
    expect(text).toBe("Pronto! Adicionei o item ao seu pedido.");
  });

  it("a rewritten_and_executed pix checkout renders too (the same committed dispatch family)", () => {
    expect(
      renderCustomerActionAnswer({
        kind: "rewritten_and_executed",
        envelope: { kind: "order.checkout.create", payload: { cartId: "c1" } },
        result: { success: true, paymentMethod: "pix", orderId: "pi_x" },
      }),
    ).toBe(PIX_LINE);
  });

  it("a DEFERRED checkout (PIX already pending) renders nothing — nothing committed", () => {
    expect(renderCustomerActionAnswer({ kind: "deferred" })).toBeUndefined();
  });
});

// ── BKL-247 — the amend / reservation.modify FAILURE gate ─────────────────────
//
// The same false-claim class BKL-230 killed for checkout, on the kinds this module
// was originally built for. `amendOrder` returns `success:false` WITHOUT throwing
// (amend-order.ts:261,:320,:361,:369,:389,:439) and `modifyReservation` likewise
// (modify-reservation.ts:139 kernel REFUSE, :168 catch-all — its body never
// throws), so both land here as `executed` carrying a FAILED result. Pre-BKL-247
// an item that was never found still rendered "Pronto! Removi o item do seu
// pedido." — proven against the built output.
//
// The gate polarity here is the INVERSE of checkout's, deliberately: these kinds
// render `success !== false` (render unless failure was REPORTED), because their
// render is payload-grounded and the committed BKL-215/BKL-231 fixtures carry NO
// `success` field — checkout's `=== true` would silently stop rendering them all.
describe("renderCustomerActionAnswer — BKL-247 amend/modify failure gate", () => {
  /** [kind, payload, the line it renders on success, a REAL executor failure]. */
  const AMEND_KINDS: ReadonlyArray<readonly [string, unknown, string, unknown]> = [
    [
      "order.amend.add_item",
      { orderId: "o1", quantity: 2 },
      "Pronto! Adicionei 2 unidades ao seu pedido.",
      // amend-order.ts:261
      { success: false, message: "ID da variante necessário para adicionar item." },
    ],
    [
      "order.amend.update_qty",
      { orderId: "o1", itemId: "i1", quantity: 3 },
      "Pronto! Atualizei a quantidade para 3 no seu pedido.",
      // amend-order.ts:361
      { success: false, message: "Nome do item e quantidade necessários." },
    ],
    [
      "order.amend.remove_item",
      { orderId: "o1", itemTitle: "picanha" },
      "Pronto! Removi o item do seu pedido.",
      // amend-order.ts:369 — THE reported defect: the item was never found.
      { success: false, message: 'Item "picanha" não encontrado no pedido.' },
    ],
  ];

  it.each(AMEND_KINDS)(
    "%s with success:false → undefined (the executor's failure is never voiced as a success)",
    (kind, payload, successLine, failure) => {
      const text = renderCustomerActionAnswer(executed(kind, payload, failure));
      expect(text).toBeUndefined();
      expect(text).not.toBe(successLine);
    },
  );

  it.each(AMEND_KINDS)("%s with success:true → renders the grounded line", (kind, payload, successLine) => {
    expect(renderCustomerActionAnswer(executed(kind, payload, { success: true, message: "ok" }))).toBe(
      successLine,
    );
  });

  // ── PIN PRESERVATION: why the polarity is `!== false`, not `=== true` ──────
  // Every committed amend fixture BKL-215 pinned (and the BKL-231 modify one)
  // carries NO `success` field. Under checkout's `=== true` polarity all of them
  // would stop rendering — reintroducing the false-FAILURE this module exists to
  // kill. Absence of `success` is NOT a reported failure.
  it.each(AMEND_KINDS)(
    "%s with NO success field → STILL renders (pin preservation — absence is not a reported failure)",
    (kind, payload, successLine) => {
      expect(renderCustomerActionAnswer(executed(kind, payload, { ok: true }))).toBe(successLine);
      expect(renderCustomerActionAnswer(executed(kind, payload, {}))).toBe(successLine);
    },
  );

  it.each([
    ["a non-boolean falsy success (success:0)", { success: 0 }],
    ['the string "false"', { success: "false" }],
    ["a null result", null],
    ["a string result", "ok"],
  ])(
    "remove_item with %s → still renders (only an explicit boolean false abstains)",
    (_label, result) => {
      expect(renderCustomerActionAnswer(executed("order.amend.remove_item", { itemId: "i1" }, result))).toBe(
        "Pronto! Removi o item do seu pedido.",
      );
    },
  );

  it("reservation.modify with success:false → undefined (modifyReservation returns, never throws)", () => {
    const text = renderCustomerActionAnswer(
      executed(
        "reservation.modify",
        { reservationId: "r1", newPartySize: 6 },
        // modify-reservation.ts:139 — a kernel REFUSE, returned not thrown.
        { success: false, reservation: null, message: "Não foi possível modificar a reserva no momento." },
      ),
    );
    expect(text).toBeUndefined();
    expect(text).not.toBe("Pronto! Sua reserva foi alterada para 6 pessoas.");
  });

  it("reservation.modify with NO success field → STILL renders (the BKL-231 pin's shape)", () => {
    expect(
      renderCustomerActionAnswer(executed("reservation.modify", { reservationId: "r1", newPartySize: 4 })),
    ).toBe("Pronto! Sua reserva foi alterada para 4 pessoas.");
  });

  it("a plan where ONE amend failed renders ONLY the successful ones", () => {
    // The failed remove must not borrow the add's success, and must not blank
    // the reply either — the customer still hears what actually happened.
    const text = renderCustomerActionAnswer({
      kind: "executed_plan",
      executions: [
        {
          envelope: { kind: "order.amend.add_item", payload: { quantity: 2 } },
          result: { success: true, message: "ok" },
        },
        {
          envelope: { kind: "order.amend.remove_item", payload: { itemTitle: "picanha" } },
          result: { success: false, message: 'Item "picanha" não encontrado no pedido.' },
        },
        {
          envelope: { kind: "order.amend.update_qty", payload: { quantity: 5 } },
          result: { ok: true },
        },
      ],
    });
    expect(text).toBe(
      "Pronto! Adicionei 2 unidades ao seu pedido.\n\nPronto! Atualizei a quantidade para 5 no seu pedido.",
    );
    expect(text).not.toContain("Removi o item");
  });

  it("a plan where EVERY amend failed renders nothing at all", () => {
    expect(
      renderCustomerActionAnswer({
        kind: "executed_plan",
        executions: [
          {
            envelope: { kind: "order.amend.add_item", payload: { quantity: 1 } },
            result: { success: false, message: "ID da variante necessário para adicionar item." },
          },
          {
            envelope: { kind: "order.amend.remove_item", payload: {} },
            result: { success: false, message: "Nome do item necessário para remover." },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("a rewritten_and_executed FAILED amend abstains too (same committed dispatch family)", () => {
    expect(
      renderCustomerActionAnswer({
        kind: "rewritten_and_executed",
        envelope: { kind: "order.amend.remove_item", payload: { itemTitle: "picanha" } },
        result: { success: false, message: 'Item "picanha" não encontrado no pedido.' },
      }),
    ).toBeUndefined();
  });

  it("the failure gate never leaks the executor's message or the item name into a reply", () => {
    // Abstaining is the whole contract: this module says nothing, the model path
    // voices the failure. It must not half-render a hedged line here.
    expect(
      renderCustomerActionAnswer(
        executed(
          "order.amend.remove_item",
          { itemTitle: "picanha" },
          { success: false, message: 'Item "picanha" não encontrado no pedido.' },
        ),
      ),
    ).toBeUndefined();
  });
});

describe("renderCustomerActionAnswer — byte-identical fall-through (scope guard)", () => {
  it("reservation.cancel → undefined (its model-prose success draft is the working precedent, unchanged)", () => {
    expect(
      renderCustomerActionAnswer(executed("reservation.cancel", { reservationId: "r1" })),
    ).toBeUndefined();
  });

  it("a non-amend committed kind (order.item.add) → undefined (model path unchanged)", () => {
    expect(
      renderCustomerActionAnswer(
        executed("order.item.add", { cartId: "c1", variantId: "v1", quantity: 1, allergens: [] }),
      ),
    ).toBeUndefined();
  });

  // BKL-230 closed the checkout render gap this pin used to describe as "separate",
  // but the fall-through it asserts is UNCHANGED and now load-bearing for a
  // different reason: checkout renders ONLY on a PROVEN-success tool result, and
  // this `acted` carries none (the default `{ ok: true }` has no `success`). A
  // committed checkout whose outcome is unknown must still reach the model path.
  it("checkout with NO success evidence in the result → undefined (outcome-gated, BKL-230)", () => {
    expect(
      renderCustomerActionAnswer(executed("order.checkout.create", { cartId: "c1" })),
    ).toBeUndefined();
  });

  it("a NON-committed acted (deferred / no envelope) → undefined", () => {
    expect(renderCustomerActionAnswer({ kind: "deferred" })).toBeUndefined();
    expect(renderCustomerActionAnswer(null)).toBeUndefined();
    expect(renderCustomerActionAnswer({})).toBeUndefined();
  });

  it("a mixed plan renders ONLY the amend action, ignoring a co-executed non-amend", () => {
    const text = renderCustomerActionAnswer({
      kind: "executed_plan",
      executions: [
        { envelope: { kind: "order.item.add", payload: { quantity: 1 } }, result: {} },
        { envelope: { kind: "order.amend.add_item", payload: { quantity: 1 } }, result: {} },
      ],
    });
    expect(text).toBe("Pronto! Adicionei o item ao seu pedido.");
  });
});
