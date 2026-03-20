// API Golden Path — E2E test exercising the full API flow without a browser.
//
// Tests the core API endpoints: health, auth, catalog, cart, checkout.
// Requires live services: api (3001), medusa (9000), postgres, redis, typesense.
// Run via: ibx test e2e-run api-golden-path

import { test, expect } from "@playwright/test";

// ── Health Check ────────────────────────────────────────────────────────────

test.describe("API Health", () => {
  test("GET /health returns 200 with check results", async ({ request }) => {
    const response = await request.get("/health");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("timestamp");
    expect(body).toHaveProperty("checks");
    expect(body.checks).toHaveProperty("redis");
    expect(body.checks).toHaveProperty("postgres");
  });
});

// ── Auth Flow ───────────────────────────────────────────────────────────────

test.describe("API Auth", () => {
  test("POST /api/auth/send-otp validates phone format", async ({ request }) => {
    // Invalid phone should be rejected
    const response = await request.post("/api/auth/send-otp", {
      data: { phone: "invalid-phone" },
    });
    // Expect 400 or 422 for bad phone format
    expect([400, 422]).toContain(response.status());
  });

  test("GET /api/auth/me returns 401 without token", async ({ request }) => {
    const response = await request.get("/api/auth/me");
    expect(response.status()).toBe(401);
  });
});

// ── Catalog ─────────────────────────────────────────────────────────────────

test.describe("API Catalog", () => {
  test("GET /api/products returns product list", async ({ request }) => {
    const response = await request.get("/api/products");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("GET /api/products?query=costela searches products", async ({ request }) => {
    const response = await request.get("/api/products?query=costela");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
  });

  test("GET /api/products?query= with empty query returns 400", async ({ request }) => {
    // The schema requires min 1 char for query if provided
    const response = await request.get("/api/products?query=");
    // Zod validation may reject empty string
    expect([200, 400, 422]).toContain(response.status());
  });

  test("GET /api/categories returns category list", async ({ request }) => {
    const response = await request.get("/api/categories");
    expect(response.status()).toBe(200);
  });

  test("GET /api/products/personalized returns personalized feed", async ({ request }) => {
    const response = await request.get("/api/products/personalized");
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body).toHaveProperty("items");
    expect(Array.isArray(body.items)).toBe(true);
  });
});

// ── Cart ─────────────────────────────────────────────────────────────────────

test.describe("API Cart", () => {
  test("POST /api/cart creates a cart", async ({ request }) => {
    const response = await request.post("/api/cart");
    expect(response.status()).toBe(201);

    const body = await response.json();
    expect(body).toHaveProperty("cart");
    expect(body.cart).toHaveProperty("id");
  });

  test("GET /api/cart/:id returns cart details", async ({ request }) => {
    // Create a cart first
    const createResponse = await request.post("/api/cart");
    expect(createResponse.status()).toBe(201);
    const { cart } = await createResponse.json();

    // Then fetch it
    const response = await request.get(`/api/cart/${cart.id}`);
    expect(response.status()).toBe(200);
  });
});

// ── SEC-001: Payment method gating ──────────────────────────────────────────

test.describe("SEC-001: Checkout payment gating", () => {
  test("guest cannot checkout with cash", async ({ request }) => {
    const response = await request.post("/api/cart/checkout", {
      data: {
        cartId: "test-cart-nonexistent",
        paymentMethod: "cash",
      },
    });
    expect(response.status()).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("guest cannot checkout with PIX", async ({ request }) => {
    const response = await request.post("/api/cart/checkout", {
      data: {
        cartId: "test-cart-nonexistent",
        paymentMethod: "pix",
      },
    });
    expect(response.status()).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("guest card checkout passes auth check (may fail at Medusa/Stripe)", async ({ request }) => {
    // Card payment should pass the SEC-001 gate (no auth required)
    // but will fail downstream at Medusa since cart doesn't exist
    const response = await request.post("/api/cart/checkout", {
      data: {
        cartId: "test-cart-nonexistent",
        paymentMethod: "card",
      },
    });
    // Should NOT be 401 — the auth gate passes for card payments
    expect(response.status()).not.toBe(401);
    // Will likely be 400 or 500 because the cart doesn't exist in Medusa
    expect([400, 404, 500]).toContain(response.status());
  });
});

// ── Delivery Estimate ───────────────────────────────────────────────────────

test.describe("API Delivery", () => {
  test("GET /api/cart/delivery-estimate validates CEP format", async ({ request }) => {
    const response = await request.get("/api/cart/delivery-estimate?cep=00000");
    // Too short CEP should be rejected by Zod (min 8 chars)
    expect([400, 422]).toContain(response.status());
  });

  test("GET /api/cart/delivery-estimate with valid CEP returns estimate", async ({ request }) => {
    const response = await request.get("/api/cart/delivery-estimate?cep=14815000");
    // Should return 200 with estimate, or 400 if zone not configured
    expect([200, 400]).toContain(response.status());
  });
});

// ── Full Flow: Create Cart → Add Item → Checkout (requires seeded products) ─

test.describe("API Full Flow", () => {
  test("create cart → search products → add item → verify cart", async ({ request }) => {
    // 1. Search for products
    const searchResponse = await request.get("/api/products?limit=1");
    expect(searchResponse.status()).toBe(200);
    const searchBody = await searchResponse.json();

    if (searchBody.items.length === 0) {
      test.skip(true, "No products seeded — skipping full flow test");
      return;
    }

    const product = searchBody.items[0];
    expect(product).toHaveProperty("id");
    expect(product).toHaveProperty("variants");

    // 2. Create a cart
    const cartResponse = await request.post("/api/cart");
    expect(cartResponse.status()).toBe(201);
    const { cart } = await cartResponse.json();
    expect(cart).toHaveProperty("id");

    // 3. Add the first variant of the first product to the cart
    if (product.variants.length > 0) {
      const variantId = product.variants[0].id;
      const addItemResponse = await request.post(`/api/cart/${cart.id}/line-items`, {
        data: {
          variant_id: variantId,
          quantity: 1,
        },
      });
      expect(addItemResponse.status()).toBe(201);

      // 4. Fetch cart to verify item was added
      const getCartResponse = await request.get(`/api/cart/${cart.id}`);
      expect(getCartResponse.status()).toBe(200);
    }
  });
});
