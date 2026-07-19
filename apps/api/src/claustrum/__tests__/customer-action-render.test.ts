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

describe("renderCustomerActionAnswer — byte-identical fall-through (scope guard)", () => {
  it("a non-amend committed kind (order.item.add) → undefined (model path unchanged)", () => {
    expect(
      renderCustomerActionAnswer(
        executed("order.item.add", { cartId: "c1", variantId: "v1", quantity: 1, allergens: [] }),
      ),
    ).toBeUndefined();
  });

  it("checkout (order.checkout.create) → undefined (not in scope — its render gap is separate)", () => {
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
