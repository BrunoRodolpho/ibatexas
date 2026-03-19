# Phase 3 — Frontend Architecture & Security Fixes

**Date:** 2026-03-18
**Audit source:** `docs/audit/07-frontend-architecture.md`

---

## Fixes Applied

### CRITICAL

| ID | Finding | Fix | Files |
|----|---------|-----|-------|
| FE-C2 | CSP allows `unsafe-eval` in both apps | Conditionally include `'unsafe-eval'` only when `NODE_ENV === 'development'` | `apps/web/next.config.mjs`, `apps/admin/next.config.mjs` |

### HIGH

| ID | Finding | Fix | Files |
|----|---------|-----|-------|
| FE-H1 | PostHog uses `localStorage` persistence | Changed to `persistence: 'cookie'`, added `secure_cookie: true`, `cross_subdomain_cookie: false` | `apps/web/src/lib/posthog.ts` |
| FE-H2 | Error boundaries leak raw `error.message` | Replaced `error.message` display with generic pt-BR message; added `console.error` for Sentry capture | `apps/web/src/app/error.tsx`, `apps/web/src/app/[locale]/error.tsx`, `apps/web/src/app/[locale]/loja/error.tsx` |

### MEDIUM

| ID | Finding | Fix | Files |
|----|---------|-----|-------|
| FE-M1 | Middleware JWT decode without signature verification | Added AUDIT-REVIEWED comment documenting intentional design | `apps/web/src/middleware.ts` |
| FE-M2 | `apiStream` has no AbortSignal cancellation | Added optional `signal?: AbortSignal` parameter, passed to `fetch()` | `apps/web/src/lib/api.ts` |
| FE-M3 | Session store persists `customerId` to localStorage | Removed `customerId` from `partialize` function; auth state rehydrated from httpOnly cookie via `hydrate()` | `apps/web/src/domains/session/session.store.ts` |
| FE-M4 | Web app ships dead admin domain code | Deleted `apps/web/src/domains/admin/` directory and `AdminSidebar.tsx`; removed barrel export | `apps/web/src/domains/admin/*`, `apps/web/src/components/molecules/AdminSidebar.tsx`, `apps/web/src/components/molecules/index.ts` |
| SEC-F06 | JWT has no revocation; 24h expiry too long | Reduced `expiresIn` from `'24h'` to `'4h'`; updated cookie `maxAge` to match | `apps/api/src/routes/auth.ts` |
| SEC-F07 | Cookie `secure: false` in non-production | Set `secure: true` unconditionally; staging must use HTTPS | `apps/api/src/routes/auth.ts` |

### LOW

| ID | Finding | Fix | Files |
|----|---------|-----|-------|
| FE-L1 | Hardcoded strings in loja error page | Replaced with `useTranslations` hook matching the pattern in `[locale]/error.tsx` | `apps/web/src/app/[locale]/loja/error.tsx` |
| FE-L3 | Dual analytics session IDs undocumented | Added design rationale comment explaining why two session ID systems exist | `apps/web/src/domains/analytics/track.ts` |
| SEC-F11 | CORS origin missing admin app | Added `CORS_ORIGIN` variable with comment documenting both web and admin origins | `.env.example` |

---

## Not Fixed (Out of Scope)

| ID | Finding | Reason |
|----|---------|--------|
| FE-C1 | Admin panel has no server-side auth | Separate phase — requires middleware + Twilio Verify OTP integration for admin app |
| FE-H3 | Admin `apiFetch` missing `x-admin-key` header | Fixed in Phase 1 (SEC-F01) |
| FE-L2 | Chat store message history unbounded | Acceptable risk — server response length bounds this in practice |

---

## Verification

- All fixes tagged with `// AUDIT-FIX: {ID}` or `// AUDIT-REVIEWED: {ID}` comments
- Dead code removal confirmed via grep: no imports reference deleted admin domain or AdminSidebar
- `apiStream` signal parameter is optional — backward-compatible with existing call in `chat.hooks.ts`
- Session store `hydrate()` already validates auth from server cookie on load — removing `customerId` from persistence is safe
