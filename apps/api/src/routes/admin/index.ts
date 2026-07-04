// Admin routes
//
// GET  /api/admin/dashboard             — aggregated KPI metrics
// GET  /api/admin/products              — proxy Medusa admin products list
// PATCH /api/admin/products/:id         — proxy Medusa admin product update
// GET  /api/admin/products/:id          — proxy Medusa admin product detail
// GET  /api/admin/orders                — proxy Medusa admin orders list
// PATCH /api/admin/orders/:id           — proxy Medusa admin order update
// GET  /api/admin/reservations          — list all reservations
// POST /api/admin/reservations/:id/checkin    — check in guest
// POST /api/admin/reservations/:id/complete   — mark completed
// GET  /api/admin/reviews               — list all reviews
// GET  /api/admin/tables                — list all tables
// POST /api/admin/tables                — create/update table
// POST /api/admin/timeslots             — generate time slots for a date range
// GET  /api/admin/schedule/shifts        — list the staff schedule (escala) over a range
// POST /api/admin/schedule/shifts        — assign a shift to a staff member (manager)
// DELETE /api/admin/schedule/shifts/:id  — remove a shift (manager)
// GET  /api/admin/ingredients            — list raw ingredients (manager) — NEW-003 stock slice
// GET  /api/admin/ingredients/low-stock  — ingredients at/below their threshold (manager)
// POST /api/admin/ingredients            — create a raw ingredient (manager)
// PATCH /api/admin/ingredients/:id       — update a raw ingredient (manager)
// DELETE /api/admin/ingredients/:id      — remove a raw ingredient (manager)
// POST /api/admin/ingredients/:id/adjust — add/subtract stock, clamp at 0 (manager)
// GET  /api/admin/recipes                — list recipes/BOMs (manager) — NEW-035 recipe + COGS
// GET  /api/admin/recipes/:id            — one recipe + its COGS (manager)
// POST /api/admin/recipes                — create a recipe/BOM (manager)
// PUT  /api/admin/recipes/:id/ingredients — replace a recipe's BOM lines (manager)
// DELETE /api/admin/recipes/:id          — remove a recipe (manager)
// GET  /api/admin/recipes/:id/cogs       — per-dish COGS: batch + per-serving (manager)
// GET  /api/admin/analytics/summary     — analytics summary (orders, revenue, AOV)
// GET  /api/admin/analytics/top-items    — best-sellers over a date range (manager)
// GET  /api/admin/analytics/refunds      — refund count/total/trend over a range (manager)
// GET  /api/admin/kitchen/tickets         — live kitchen ticket board (oldest-first) (manager)

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { optionalAuth } from "../../middleware/auth.js";
import { dashboardRoutes } from "./dashboard.js";
import { productRoutes } from "./products.js";
import { orderRoutes } from "./orders.js";
import { reservationRoutes } from "./reservations.js";
import { reviewRoutes } from "./reviews.js";
import { tableRoutes } from "./tables.js";
import { scheduleShiftRoutes } from "./schedule-shifts.js";
import { ingredientRoutes } from "./ingredients.js";
import { recipeRoutes } from "./recipes.js";
import { specialRoutes } from "./specials.js";
import { deliveryZoneRoutes } from "./delivery-zones.js";
import { analyticsRoutes } from "./analytics.js";
import { adminAnalyticsReportRoutes } from "./analytics-reports.js";
import { scheduleRoutes } from "./schedule.js";
import { adminPaymentRoutes } from "./payments.js";
import { adminOrderActionRoutes } from "./order-actions.js";
import { adminBannerRoutes } from "./banner.js";
import { adminAgentApprovalRoutes } from "./agent-approvals.js";
import { adminConfirmationRoutes } from "./confirmations.js";
import { conversationRoutes } from "./conversations.js";
import { escalationRoutes } from "./escalations.js";
import { adminIncidentRoutes } from "./incidents.js";
import { adminOpsAlertRoutes } from "./ops-alerts.js";
import { adminCaixaRoutes } from "./caixa.js";
import { adminKitchenRoutes } from "./kitchen.js";
import { broadcastRoutes } from "./broadcast.js";

// ── W4 P1-H — API-key role registry ─────────────────────────────────────
//
// `ADMIN_API_KEY_ROLES_JSON` maps an API KEY → role (`"MANAGER"|"OWNER"`).
// At startup we parse the JSON and pre-compute Buffers for timing-safe
// compare. The admin guard sets `request.adminApiKeyRole` to the matched
// role; downstream `requireManagerRole` / `requireOwnerRole` gate on it.
//
// An API key NOT in the registry passes the outer admin guard (it's in
// `ADMIN_API_KEYS`, so the key itself is authentic) but does NOT receive
// a role. Routes guarded by `requireManagerRole` / `requireOwnerRole`
// will then return 403, defeating the "one leaked key = full power"
// failure mode (audit 05 §S2).
//
// JSON shape:
//   { "<api-key-string>": "MANAGER", "<other-key-string>": "OWNER" }
//
// Production guidance: every API key listed in `ADMIN_API_KEY` SHOULD
// also have an entry in `ADMIN_API_KEY_ROLES_JSON`. Keys without a
// registry entry are downgraded to "no role" → only read-only routes
// (those without `requireManagerRole`/`requireOwnerRole`) remain
// accessible.
type AdminApiKeyRole = "OWNER" | "MANAGER";

function parseApiKeyRolesRegistry(server: FastifyInstance): ReadonlyMap<string, AdminApiKeyRole> {
  const raw = process.env.ADMIN_API_KEY_ROLES_JSON ?? "";
  if (raw.length === 0) {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    const out = new Map<string, AdminApiKeyRole>();
    for (const [key, role] of Object.entries(parsed)) {
      if (role !== "OWNER" && role !== "MANAGER") {
        server.log.warn(
          { key: `${key.slice(0, 4)}...`, role },
          "ADMIN_API_KEY_ROLES_JSON entry has unsupported role — skipping",
        );
        continue;
      }
      out.set(key, role);
    }
    return out;
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `ADMIN_API_KEY_ROLES_JSON is malformed: ${(err as Error).message}`,
      );
    }
    server.log.warn(
      { err: (err as Error).message },
      "ADMIN_API_KEY_ROLES_JSON malformed — proceeding with empty registry",
    );
    return new Map();
  }
}

export async function adminRoutes(server: FastifyInstance): Promise<void> {
  // Support comma-separated list of valid API keys for rotation
  const ADMIN_API_KEYS = (process.env.ADMIN_API_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  for (const key of ADMIN_API_KEYS) {
    if (key.length < 32) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("ADMIN_API_KEY entries must be at least 32 characters");
      }
      server.log.warn("ADMIN_API_KEY entry shorter than 32 chars — insecure");
    }
  }

  // P1-H — parse the API-key role registry. Empty map = no API key
  // receives a role (all destructive routes fail-closed).
  const ADMIN_API_KEY_ROLES = parseApiKeyRolesRegistry(server);

  // P1-H production warning: any API key in ADMIN_API_KEYS missing
  // from the role registry will fail-closed on every Manager / Owner
  // gated route. Log a one-shot warning at boot so operators notice.
  for (const key of ADMIN_API_KEYS) {
    if (!ADMIN_API_KEY_ROLES.has(key)) {
      server.log.warn(
        { key: `${key.slice(0, 4)}...` },
        "ADMIN_API_KEY entry has no ADMIN_API_KEY_ROLES_JSON role mapping — " +
          "destructive admin routes will refuse this key (W4 P1-H fail-closed).",
      );
    }
  }

  // DOM-001: Auth guard — accept EITHER x-admin-key header OR valid staff JWT cookie.
  // The staff JWT path runs optionalAuth first (populates request.staffId/staffRole),
  // then checks for staff credentials. Falls back to API key if no staff JWT.
  server.addHook("preHandler", async (request, reply) => {
    // Try staff JWT first (optionalAuth sets staffId/staffRole if present)
    await new Promise<void>((resolve) => {
      // Resolve regardless of outcome: JWT verification success OR failure
      // both fall through to the API-key check below.
      optionalAuth(request, reply, () => resolve());
    });

    // If staff JWT is valid, allow through
    if (request.staffId && request.staffRole) {
      return;
    }

    // Fall back to API key auth
    if (ADMIN_API_KEYS.length === 0) {
      return reply.code(503).send({ error: "Service unavailable" });
    }
    const key = request.headers["x-admin-key"];
    if (typeof key !== "string" || key.length === 0) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    // Timing-safe comparison against all valid keys
    const keyBuf = Buffer.from(key);
    const matched = ADMIN_API_KEYS.find((validKey) => {
      const expectedBuf = Buffer.from(validKey);
      if (keyBuf.length !== expectedBuf.length) return false;
      return timingSafeEqual(keyBuf, expectedBuf);
    });
    if (!matched) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
    // P1-H — if the matched key has a role mapping in the registry,
    // attach it to the request. Otherwise `request.adminApiKeyRole`
    // stays undefined and downstream role gates fail-closed.
    const role = ADMIN_API_KEY_ROLES.get(matched);
    if (role) {
      request.adminApiKeyRole = role;
    }
  });

  // Audit logging — log all admin operations (includes staff identity when available)
  server.addHook("onResponse", async (request, reply) => {
    server.log.info({
      admin: true,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      ...(request.staffId ? { staffId: request.staffId, staffRole: request.staffRole } : {}),
    }, "admin request");
  });

  // Register all admin sub-routes
  await server.register(dashboardRoutes);
  await server.register(productRoutes);
  await server.register(orderRoutes);
  await server.register(reservationRoutes);
  await server.register(reviewRoutes);
  await server.register(tableRoutes);
  await server.register(scheduleShiftRoutes);
  await server.register(ingredientRoutes);
  await server.register(recipeRoutes);
  await server.register(specialRoutes);
  await server.register(deliveryZoneRoutes);
  await server.register(analyticsRoutes);
  await server.register(adminAnalyticsReportRoutes);
  await server.register(scheduleRoutes);
  await server.register(adminPaymentRoutes);
  await server.register(adminOrderActionRoutes);
  await server.register(adminBannerRoutes);
  await server.register(adminAgentApprovalRoutes);
  await server.register(adminConfirmationRoutes);
  await server.register(conversationRoutes);
  await server.register(escalationRoutes);
  await server.register(adminIncidentRoutes);
  await server.register(adminOpsAlertRoutes);
  await server.register(adminCaixaRoutes);
  await server.register(adminKitchenRoutes);
  await server.register(broadcastRoutes);
}
