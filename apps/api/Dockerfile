# AUDIT-FIX: INFRA-04 — Multi-stage Dockerfile for the API service
# Build from repo root: docker build -f apps/api/Dockerfile .

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS build

RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY packages/ packages/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Build the API and its workspace dependencies
RUN pnpm --filter @ibatexas/api... run build

# ── Stage 2: production ─────────────────────────────────────────────────────
FROM node:20-alpine AS production

RUN corepack enable && corepack prepare pnpm@8.15.0 --activate

ENV NODE_ENV=production

WORKDIR /app

# Copy workspace manifests
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/ packages/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts from build stage
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/domain/dist packages/domain/dist
COPY --from=build /app/packages/tools/dist packages/tools/dist
COPY --from=build /app/packages/types/dist packages/types/dist
COPY --from=build /app/packages/nats-client/dist packages/nats-client/dist
COPY --from=build /app/packages/llm-provider/dist packages/llm-provider/dist

# Copy Prisma generated client (needed at runtime)
COPY --from=build /app/packages/domain/src/generated packages/domain/src/generated
COPY --from=build /app/packages/domain/prisma packages/domain/prisma

# Non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
USER appuser

EXPOSE 9000

CMD ["node", "apps/api/dist/index.js"]
