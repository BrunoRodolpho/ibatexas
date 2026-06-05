// Access log — replaces Fastify's default per-request logging (disabled via
// `disableRequestLogging` in server.ts).
//
// Fastify's built-in logger emitted an "incoming request" + "request completed"
// pair on EVERY request — OPTIONS CORS preflight, the dashboard's ~20–30s
// /api/schedule/status + /api/admin/orders polls — which buried every useful line
// and made VictoriaLogs/`ibx logs` useless. This hook is the inverse: it stays
// SILENT for benign traffic and only emits when a human would care:
//   - 5xx                                   → error  (event: http.error)
//   - 4xx                                   → warn   (event: http.error)
//   - slow 2xx/3xx (> ACCESS_LOG_SLOW_MS)   → info   (event: http.slow)
// OPTIONS is never logged. Every line carries component:"http" so it streams under
// {component="http"} in VictoriaLogs and is filterable via `ibx logs --component http`.

import type { FastifyInstance } from "fastify";

// process.env per Hard Rule #3 — never hardcode thresholds.
const SLOW_MS = Number(process.env.ACCESS_LOG_SLOW_MS ?? 1000);

/**
 * Register the access-log hook. Added at the root (not plugin-encapsulated) so it
 * applies to every route. Pairs with `disableRequestLogging: true`.
 */
export function registerAccessLog(server: FastifyInstance): void {
  server.addHook("onResponse", (request, reply, done) => {
    // CORS preflight is pure noise — never log it.
    if (request.method === "OPTIONS") return done();

    const statusCode = reply.statusCode;
    const durationMs = Math.round(reply.elapsedTime);
    // Route template (e.g. /api/admin/orders), not the raw URL — drops the query
    // string (?limit=20&offset=0) so Grafana/LogsQL can group by path with low
    // cardinality. Falls back to the path for unmatched (404) requests.
    const url = request.routeOptions?.url ?? request.url.split("?")[0];

    const base = {
      component: "http",
      method: request.method,
      url,
      statusCode,
      durationMs,
      reqId: request.id,
    };

    if (statusCode >= 500) {
      request.log.error({ ...base, event: "http.error" }, "http request failed");
    } else if (statusCode >= 400) {
      request.log.warn({ ...base, event: "http.error" }, "http request rejected");
    } else if (durationMs > SLOW_MS) {
      request.log.info({ ...base, event: "http.slow" }, "http request slow");
    }
    // Benign 2xx/3xx within the latency budget → emit nothing.

    done();
  });
}
