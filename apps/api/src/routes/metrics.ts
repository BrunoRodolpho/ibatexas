// Prometheus scrape endpoint for the kernel `MetricsSink` adapter.
//
// Auth: requires `x-prometheus-token` header equal to `PROMETHEUS_TOKEN`. If
// the env var is unset, the endpoint replies 503 — closed by default, never
// expose without authentication. Configured per CLAUDE.md rule #3.
//
// Wiring: the same `prom-client` Registry passed to `createKernelMetricsSink`
// is injected here so this route exposes exactly what the sink populates.

import type { FastifyInstance } from "fastify"
import type { Registry } from "prom-client"

export interface MetricsRouteOptions {
  /** Shared prom-client Registry — must be the same instance the sink writes to. */
  readonly register: Registry
}

export function metricsRoutes(
  opts: MetricsRouteOptions,
): (server: FastifyInstance) => Promise<void> {
  return async function metricsRoutesPlugin(server): Promise<void> {
    server.get("/metrics", {
      schema: {
        tags: ["observability"],
        summary: "Prometheus scrape endpoint (token-gated).",
        hide: true,
      },
      config: {
        // Skip default rate-limit — scrapers run frequently and are auth-gated.
        rateLimit: false,
      },
      handler: async (request, reply) => {
        const expected = process.env.PROMETHEUS_TOKEN
        if (!expected || expected.length === 0) {
          // Closed by default — no token configured ⇒ no scraping permitted.
          return reply
            .status(503)
            .header("content-type", "text/plain; charset=utf-8")
            .send("PROMETHEUS_TOKEN not configured")
        }
        const provided = request.headers["x-prometheus-token"]
        const providedToken = Array.isArray(provided) ? provided[0] : provided
        if (providedToken !== expected) {
          return reply
            .status(401)
            .header("content-type", "text/plain; charset=utf-8")
            .send("invalid prometheus token")
        }
        const body = await opts.register.metrics()
        return reply
          .status(200)
          .header("content-type", opts.register.contentType)
          .send(body)
      },
    })
  }
}
