// admin/schedule-shifts.ts — the NEW-016 escala surface. Manager-gated REST over
// the StaffScheduleService: assign shifts to staff + list the schedule over a
// date range + delete a shift.
//
//   GET    /api/admin/schedule/shifts?from=&to=&staffId=  → { range, shifts }
//   POST   /api/admin/schedule/shifts                      → 201 { shift }
//   DELETE /api/admin/schedule/shifts/:id                  → 200 { shift } | 404
//   POST   /api/admin/schedule/shifts/:id/clock-in         → 200 { shift } | 404  (NEW-034)
//   POST   /api/admin/schedule/shifts/:id/clock-out        → 200 { shift } | 404  (NEW-034)
//   GET    /api/admin/schedule/labor-cost?from=&to=        → LaborCostReport      (NEW-034)
//
// Mirrors admin/tables.ts + admin/analytics-reports.ts: `withTypeProvider`,
// zod schemas, a lazily-constructed service (so a test mounting the plugin with a
// partial `@ibatexas/domain` mock doesn't trip over a missing factory at register
// time), and a `requireManagerRole` preHandler that fail-closes to 403.
//
// Plain CRUD (NOT kernel-adjudicated): scheduling is admin-ops, not a customer
// money/safety path — the manager-gate IS the authority here (mirrors tables).
// When `to`/`from` are omitted the range defaults to a trailing 7-day window
// ending tomorrow, resolved in RESTAURANT_TIMEZONE — the SAME zone the service
// resolves the range boundary in, so a default range is the restaurant's business
// days (not the server's local days).

import type { FastifyInstance } from "fastify";
import { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createLaborCostService, createStaffScheduleService } from "@ibatexas/domain";
import { requireManagerRole } from "../../middleware/staff-auth.js";
import { shiftYmd, todayInRestaurantTz } from "./_date-defaults.js";

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const ListQuery = z.object({
  // Range [from, to) — YYYY-MM-DD, from inclusive / to exclusive. Both optional;
  // default to a trailing 7-day window ending tomorrow in RESTAURANT_TIMEZONE.
  from: YMD.optional(),
  to: YMD.optional(),
  staffId: z.string().min(1).max(256).optional(),
});

const CreateBody = z
  .object({
    staffId: z.string().min(1).max(256),
    // Absolute instants (ISO 8601). z.coerce.date parses the string to a Date.
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    role: z.string().min(1).max(64).optional(),
    note: z.string().max(1000).optional(),
  })
  .refine((b) => b.endsAt > b.startsAt, {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

// NEW-034 clock-in / clock-out — optional `at` (ISO 8601) lets a manager backdate a
// correction; omitted → the service stamps `now`. `.nullish()` so a plain POST with
// NO payload (Fastify sets body to `null`) validates and clocks at the current
// instant — a bare `.optional()` would 400 on the null a bodyless POST produces.
const ClockBody = z.object({ at: z.coerce.date().optional() }).nullish();

// NEW-034 labor-cost — same [from, to) range shape as the shift list; both optional
// and default to the trailing 7-day window in RESTAURANT_TIMEZONE (via resolveRange).
const LaborCostQuery = z.object({
  from: YMD.optional(),
  to: YMD.optional(),
});

/**
 * Resolve the effective [from, to) range. `to` is EXCLUSIVE, so an omitted `to`
 * defaults to tomorrow (today + 1) to include today; an omitted `from` defaults
 * to 6 days before the effective `to` (a 7-day window). Both in RESTAURANT_TIMEZONE.
 */
function resolveRange(q: { from?: string; to?: string }): { from: string; to: string } {
  const to = q.to ?? shiftYmd(todayInRestaurantTz(), 1);
  const from = q.from ?? shiftYmd(to, -7);
  return { from, to };
}

export async function scheduleShiftRoutes(server: FastifyInstance): Promise<void> {
  const app = server.withTypeProvider<ZodTypeProvider>();

  // Lazily construct on first request (NOT at registration) so a test mounting
  // this plugin with a partial `@ibatexas/domain` mock doesn't trip over a missing
  // factory at register time (mirrors analytics-reports.ts / ops-alerts.ts).
  let scheduleSvc: ReturnType<typeof createStaffScheduleService> | undefined;
  const svc = () => (scheduleSvc ??= createStaffScheduleService());
  let laborSvc: ReturnType<typeof createLaborCostService> | undefined;
  const labor = () => (laborSvc ??= createLaborCostService());

  // ── GET /api/admin/schedule/shifts — list the schedule over a range ──────────
  app.get(
    "/api/admin/schedule/shifts",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Escala — listar turnos por período (admin)",
        querystring: ListQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof ListQuery>;
      const range = resolveRange(q);
      const shifts = await svc().listShifts({
        from: range.from,
        to: range.to,
        ...(q.staffId ? { staffId: q.staffId } : {}),
      });
      return reply.send({ range, shifts });
    },
  );

  // ── POST /api/admin/schedule/shifts — assign a shift to a staff member ───────
  app.post(
    "/api/admin/schedule/shifts",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Escala — atribuir turno a um funcionário (admin)",
        body: CreateBody,
      },
    },
    async (request, reply) => {
      const body = request.body as z.infer<typeof CreateBody>;
      const shift = await svc().createShift({
        staffId: body.staffId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
      return reply.status(201).send({ shift });
    },
  );

  // ── DELETE /api/admin/schedule/shifts/:id — remove a shift ───────────────────
  app.delete(
    "/api/admin/schedule/shifts/:id",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Escala — remover um turno (admin)",
        params: z.object({ id: z.string().min(1).max(256) }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const shift = await svc().deleteShift(id);
      // 404 ONLY when the id does not exist (deleteShift returns null).
      if (!shift) {
        return reply.code(404).send({ error: "staff_shift_not_found" });
      }
      return reply.send({ shift });
    },
  );

  // ── POST /api/admin/schedule/shifts/:id/{clock-in,clock-out} (NEW-034) ─────────
  // The two clock stamps are identical but for which service method they call; a
  // shared registration keeps them in lockstep (differ only in path + method).
  const clockEndpoints = [
    { suffix: "clock-in", method: "clockIn", summary: "Escala — registrar entrada (clock-in) de um turno (admin)" },
    { suffix: "clock-out", method: "clockOut", summary: "Escala — registrar saída (clock-out) de um turno (admin)" },
  ] as const;
  for (const { suffix, method, summary } of clockEndpoints) {
    app.post(
      `/api/admin/schedule/shifts/:id/${suffix}`,
      {
        preHandler: [requireManagerRole],
        schema: {
          tags: ["admin"],
          summary,
          params: z.object({ id: z.string().min(1).max(256) }),
          body: ClockBody,
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as z.infer<typeof ClockBody>;
        const shift = await svc()[method](id, body?.at);
        // 404 ONLY when the id does not exist (the clock method returns null).
        if (!shift) {
          return reply.code(404).send({ error: "staff_shift_not_found" });
        }
        return reply.send({ shift });
      },
    );
  }

  // ── GET /api/admin/schedule/labor-cost — scheduled/actual hours + cost (NEW-034)
  app.get(
    "/api/admin/schedule/labor-cost",
    {
      preHandler: [requireManagerRole],
      schema: {
        tags: ["admin"],
        summary: "Escala — custo de mão de obra por período (admin)",
        querystring: LaborCostQuery,
      },
    },
    async (request, reply) => {
      const q = request.query as z.infer<typeof LaborCostQuery>;
      const range = resolveRange(q);
      const report = await labor().getLaborCost({ from: range.from, to: range.to });
      return reply.send(report);
    },
  );
}
