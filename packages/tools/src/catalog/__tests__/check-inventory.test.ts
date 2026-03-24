// Tests for check_inventory tool
//
// Validates:
//   1. Returns available=true when stock > 0
//   2. Returns available=false when stock = 0

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock Medusa admin client ─────────────────────────────────────────────────

const mockMedusaAdmin = vi.fn();

vi.mock("../../medusa/client.js", () => ({
  medusaAdmin: (...args: unknown[]) => mockMedusaAdmin(...args),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

import { checkInventory } from "../check-inventory.js";

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("checkInventory", () => {
  it("returns available=true when stock > 0", async () => {
    mockMedusaAdmin.mockResolvedValue({
      inventory_items: [{ stocked_quantity: 10 }],
    });

    const result = await checkInventory({ variantId: "variant_123" });

    expect(result.available).toBe(true);
    expect(result.quantity).toBe(10);
    expect(result.nextAvailableAt).toBeNull();
    expect(mockMedusaAdmin).toHaveBeenCalledWith(
      "/admin/inventory-items?variant_id=variant_123",
    );
  });

  it("returns available=false when stock=0", async () => {
    mockMedusaAdmin.mockResolvedValue({
      inventory_items: [{ stocked_quantity: 0 }],
    });

    const result = await checkInventory({ variantId: "variant_456" });

    expect(result.available).toBe(false);
    expect(result.quantity).toBe(0);
    expect(result.nextAvailableAt).toBeNull();
  });
});
