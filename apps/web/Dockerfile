# AUDIT-FIX: INFRA-04 — Multi-stage Dockerfile for the Web (Next.js) service
# Build from repo root: docker build -f apps/web/Dockerfile .

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/ packages/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy the full web app source for next build
COPY apps/web/ apps/web/

# Build with standalone output
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @ibatexas/web run build

# ── Stage 2: production ─────────────────────────────────────────────────────
FROM node:22-alpine AS production

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Copy standalone server (includes node_modules)
COPY --from=build /app/apps/web/.next/standalone ./
# Copy static assets
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
# Copy public directory
COPY --from=build /app/apps/web/public apps/web/public

# Non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "apps/web/server.js"]
