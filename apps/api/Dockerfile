# AUDIT-FIX: INFRA-04 — Multi-stage Dockerfile for the API service
# Build from repo root: docker build -f apps/api/Dockerfile .

# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:22-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
# git is needed to clone the @adjudicate/* sibling repo at build time —
# pnpm-workspace.yaml references `../adjudicate/packages/*` until @adjudicate
# is published to npm. See docs/architecture/decisions.md ADR #13.
RUN apk add --no-cache git

WORKDIR /app

# Clone the platform sibling repo at /adjudicate so `../adjudicate` (relative
# to /app) resolves correctly for the workspace include.
ARG ADJUDICATE_REF=main
RUN git clone --depth=1 --branch "$ADJUDICATE_REF" \
      https://github.com/BrunoRodolpho/adjudicate.git /adjudicate

# Copy workspace manifests first for layer caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY packages/ packages/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy API source code
COPY apps/api/src apps/api/src

# Build the API and its workspace dependencies
RUN pnpm --filter @ibatexas/api... run build

# ── Stage 2: production ─────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:22-alpine AS production

RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

ENV NODE_ENV=production

WORKDIR /app

# Carry the @adjudicate sibling from the build stage — it has the dist/
# files produced by `pnpm --filter @ibatexas/api... run build`, which the
# api runtime resolves through workspace symlinks.
COPY --from=build /adjudicate /adjudicate

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

# Prisma 7: generated client is compiled by tsc into dist/ (no more engine binaries).
# The src/generated copy is no longer needed — dist/ has the compiled JS.
# Keep prisma/ dir + prisma.config.ts for `prisma migrate deploy` in production.
COPY --from=build /app/packages/domain/prisma packages/domain/prisma
COPY --from=build /app/packages/domain/prisma.config.ts packages/domain/prisma.config.ts

# Non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
USER appuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "apps/api/dist/index.js"]
