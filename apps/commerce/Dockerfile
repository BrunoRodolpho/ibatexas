# Multi-stage Dockerfile for the Medusa v2 commerce service.
# Build from repo root: docker build -f apps/commerce/Dockerfile .
#
# Medusa v2 compiles TypeScript + admin SPA via `medusa build` into
# apps/commerce/.medusa/server/. The runtime invokes `medusa start` from
# the commerce workspace, which reads medusa-config.ts and loads the
# compiled output.
#
# The Medusa CLI itself (@medusajs/cli) lives in devDependencies so the
# runtime stage does NOT pass --prod to pnpm install — we need the CLI
# binary in node_modules/.bin. Accept the image-size hit; the machine
# constraint is memory, not disk.

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

# Workspace manifests first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/commerce/package.json apps/commerce/tsconfig.json apps/commerce/
COPY packages/ packages/

# Install all dependencies (need devDeps: @medusajs/cli, typescript, ts-node)
RUN pnpm install --frozen-lockfile

# Copy commerce source + config + static assets used by seed
COPY apps/commerce/src apps/commerce/src
COPY apps/commerce/medusa-config.ts apps/commerce/
COPY apps/commerce/static apps/commerce/static

# Build workspace deps first (tools/types/nats-client), then Medusa itself.
# `medusa build` outputs to apps/commerce/.medusa/server/.
RUN pnpm --filter @ibatexas/tools... run build \
 && cd apps/commerce \
 && pnpm exec medusa build

# ── Stage 2: production ─────────────────────────────────────────────────────
FROM node:22-alpine AS production

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

ENV NODE_ENV=production

WORKDIR /app

# Workspace manifests + source-less packages for workspace resolution
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/commerce/package.json apps/commerce/
COPY packages/ packages/

# Install all deps (CLI is in devDependencies). --frozen-lockfile so we
# ship exactly what the build stage used.
RUN pnpm install --frozen-lockfile

# Compiled Medusa server + admin SPA
COPY --from=build /app/apps/commerce/.medusa apps/commerce/.medusa
COPY --from=build /app/apps/commerce/medusa-config.ts apps/commerce/medusa-config.ts
COPY --from=build /app/apps/commerce/static apps/commerce/static

# Workspace package builds used by seed.ts (nats-client, tools, types)
COPY --from=build /app/packages/tools/dist packages/tools/dist
COPY --from=build /app/packages/types/dist packages/types/dist
COPY --from=build /app/packages/nats-client/dist packages/nats-client/dist

# Non-root user
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup && \
    chown -R appuser:appgroup /app
USER appuser

WORKDIR /app/apps/commerce

EXPOSE 9000

# Medusa boot is slow on cold start — migrations + module load take 30-45s
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:9000/health || exit 1

CMD ["pnpm", "exec", "medusa", "start"]
