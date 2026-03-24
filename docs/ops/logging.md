# Structured Logging — IbateXas API

## Configuration

| Variable    | Default | Description                          |
|-------------|---------|--------------------------------------|
| `LOG_LEVEL` | `info`  | Pino log level (`trace` through `fatal`) |
| `NODE_ENV`  | —       | When not `production`, enables pino-pretty |

## Format

- **Production:** JSON (one object per line on stdout)
- **Development:** Pretty-printed with colors via `pino-pretty`

Timestamps use ISO 8601 format (`pino.stdTimeFunctions.isoTime`).

## Logger instances

### Fastify server logger

Configured in `apps/api/src/server.ts` via the `Fastify({ logger: ... })` option. Each request automatically gets a child logger with `reqId` for distributed tracing.

Use `request.log.info(...)` inside route handlers.

### Standalone logger

Defined in `apps/api/src/lib/logger.ts`. Used in contexts without a request:

- **Startup** (`index.ts`) — process-level errors, initialization
- **Background jobs** (`jobs/*.ts`) — accept `FastifyBaseLogger` via `startXxx(log)`, fall back to module-level logger
- **WhatsApp client** (`whatsapp/client.ts`, `whatsapp/init.ts`)
- **Config validation** (`config.ts`)

Import:

```ts
import logger from "../lib/logger.js";
```

## Request logging

Fastify logs every request/response automatically. Each request gets a child logger with:

- `reqId` — from `X-Request-Id` header or auto-generated UUID (see `plugins/request-id.ts`)
- Route handlers access it via `request.log`

## Log levels

| Level   | Use                                      |
|---------|------------------------------------------|
| `trace` | Very verbose debugging                   |
| `debug` | Detailed diagnostic info                 |
| `info`  | Normal operations, state transitions     |
| `warn`  | Degraded state, rate limits, missing config |
| `error` | Failures requiring attention             |
| `fatal` | Process-ending errors (uncaught exceptions) |

## CloudWatch (production)

The ECS task definition uses the `awslogs` log driver, which sends container stdout (JSON lines) directly to CloudWatch Log Groups. No additional log shipping is needed.

Log group naming: `/ecs/ibatexas-api`

CloudWatch Logs Insights can query structured fields:

```
fields @timestamp, msg, reqId
| filter level >= 40
| sort @timestamp desc
| limit 50
```
