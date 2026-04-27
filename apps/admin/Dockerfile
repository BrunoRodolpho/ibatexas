# AUDIT-FIX: INFRA-04 — Multi-stage Dockerfile for the Admin (Next.js) service
# Build from repo root: docker build -f apps/admin/Dockerfile .

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
COPY apps/admin/package.json apps/admin/
COPY packages/ packages/

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy the full admin app source for next build
COPY apps/admin/ apps/admin/

# NEXT_PUBLIC_* vars are inlined into the client bundle at build time AND
# baked into the server-rendered CSP header (see apps/admin/next.config.mjs).
# Must be supplied by the CI build-args.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

# Build with standalone output
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @ibatexas/admin... run build

# ── Stage 2: production ─────────────────────────────────────────────────────
FROM public.ecr.aws/docker/library/node:22-alpine AS production

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

# Copy standalone server (includes node_modules)
COPY --from=build /app/apps/admin/.next/standalone ./
# Copy static assets
COPY --from=build /app/apps/admin/.next/static apps/admin/.next/static

# Non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
USER appuser

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3002/ || exit 1

CMD ["node", "apps/admin/server.js"]
