# 07 Audit: Frontend Architecture (Web + Admin)

## Executive Summary

The frontend has a solid foundation: proper i18n architecture, type-safe Zustand stores, dual-channel analytics with dedup guards, and good error boundary coverage. However, there are **2 critical** and **3 high-severity** findings:

1. **[C1] Admin panel has zero server-side auth** — no middleware, no route protection. The `useState`-based gate is client-only; all admin HTML/JS/data-fetching code is delivered to any visitor. The API layer requires `x-admin-key`, but the admin `apiFetch` never sends it, so the admin panel is simultaneously publicly accessible (pages) and non-functional (API calls).
2. **[C2] CSP allows `unsafe-eval` on both apps** — negates much of the XSS protection CSP is designed to provide.
3. **[H1] PostHog uses `localStorage` persistence** — session/analytics identifiers stored in localStorage contradict the system invariant that auth tokens must never be in localStorage (though the JWT itself is correctly in httpOnly cookies, the PostHog distinct_id is in localStorage).
4. **[H2] Error boundaries leak raw `error.message` to users** — server error messages (potentially containing internal details) are rendered directly in the UI.
5. **[H3] Admin `apiFetch` missing `x-admin-key` header** — confirmed by security-auditor. Every admin API call will fail with 401 in production.

No deprecated admin routes were found in `apps/web` (clean).

## Scope

| App | Path | Framework |
|-----|------|-----------|
| Customer storefront | `apps/web` | Next.js 14 + next-intl |
| Admin panel | `apps/admin` | Next.js 14 (standalone) |
| Shared UI library | `packages/ui` | React component library |
| Analytics | PostHog (client) + NATS (server via sendBeacon) |

Files audited: middleware.ts, layout.tsx (root + locale + admin), session.store.ts, cart.store.ts, events.ts, track.ts, api.ts (web + admin), chat.store.ts, chat.hooks.ts, next.config.mjs (web + admin), posthog.ts, error.tsx (3 files), admin pages, packages/ui structure.

## System Invariants (Must Always Be True)

| # | Invariant | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Admin pages never accessible to unauthenticated users | **VIOLATED** | No middleware.ts in admin app; layout.tsx uses client-side `useState` only |
| 2 | No sensitive data exposed in client-side bundles | OK | NEXT_PUBLIC_ vars are non-sensitive (API URL, PostHog key, WhatsApp URL, social links, hours) |
| 3 | All user-facing text is pt-BR | OK | next-intl used consistently; only locale is `pt-BR`; error pages use Portuguese |
| 4 | Analytics events match documentation | OK | `AnalyticsEvent` union and `docs/analytics-dashboards.md` are in sync |
| 5 | Auth tokens never in localStorage (only httpOnly cookies) | **PARTIAL** | JWT is in httpOnly cookie (correct), but PostHog `persistence: 'localStorage'` stores tracking identifiers there |

## Assumptions That May Be False

| Assumption | Evidence | Risk if False |
|------------|----------|---------------|
| Admin panel is not deployed to production yet | Layout has "Step 11 replaces with Twilio Verify OTP" comment | If deployed, entire admin UI is publicly accessible |
| `x-admin-key` is set in admin API calls | `apps/admin/src/lib/api.ts` never sends the header | Admin API calls all fail with 401/403 — admin panel is non-functional |
| CSP `unsafe-eval` is temporary for dev | Present in both web and admin `next.config.mjs` production configs | XSS attacks can execute arbitrary code via `eval()` in production |
| PostHog localStorage is acceptable because it's "just analytics" | `persistence: 'localStorage'` in posthog.ts:35 | If PostHog ever stores PII (after identify call), it's in localStorage |
| Error messages from API are safe to show users | error.tsx files render `error.message` directly | Internal stack traces or DB errors could leak to UI |
| `apiStream` reader cleanup is always called | `chat.hooks.ts` relies on `apiStream` which has a finally block | If the component unmounts mid-stream, the reader is released (OK) but no AbortController cancels the fetch |

## Findings

### C1: Admin Panel Has No Server-Side Auth [CRITICAL]

**Severity:** C (Critical)
**File:** `apps/admin/src/app/admin/layout.tsx:13`

**Evidence:**
```typescript
const [isStaff, setIsStaff] = useState(process.env.NODE_ENV !== 'production')
```

The admin layout uses a React `useState` hook for auth. This is client-side only:
- **No `middleware.ts`** exists in `apps/admin/src/` — confirmed by glob search returning no results.
- **No server-side page protection** — the root layout (`apps/admin/src/app/layout.tsx`) renders `{children}` unconditionally.
- In production, `isStaff` initializes to `false`, so the "Acesso restrito" screen shows — but this is purely cosmetic. The full admin JS bundle, component tree, and data-fetching hooks are still shipped to the client.

**Blast Radius:** Any visitor to the admin URL receives the complete admin application code. While API calls will fail (due to missing `x-admin-key`), the admin UI structure, route names, component logic, and API endpoint paths are all exposed.

**Exploitability:** Medium. An attacker can:
1. View all admin page routes and API endpoints from the shipped JS bundle
2. Understand the internal data model from the admin hooks/components
3. Bypass the `useState` gate trivially via browser devtools: `__NEXT_DATA__` or React DevTools to flip `isStaff`

**Production Simulation:** Deploy admin app, visit `/admin` — full HTML/JS served, "Acesso restrito" overlay shown but easily bypassable client-side.

---

### C2: CSP Allows `unsafe-eval` in Both Apps [CRITICAL]

**Severity:** C (Critical)
**Files:**
- `apps/web/next.config.mjs:42` — `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://app.posthog.com`
- `apps/admin/next.config.mjs:31` — `script-src 'self' 'unsafe-inline' 'unsafe-eval'`

**Evidence:** Both Next.js configs include `'unsafe-eval'` and `'unsafe-inline'` in the CSP `script-src` directive. This effectively nullifies CSP as an XSS defense layer, because any injected script can run `eval()` and inline scripts execute freely.

**Blast Radius:** If any XSS vector exists (or is introduced), CSP will not block it. This affects all users of both apps.

**Exploitability:** High — `unsafe-eval` + `unsafe-inline` is equivalent to no CSP for script execution.

**Note:** Next.js requires `unsafe-inline` for its hydration scripts in development, but `unsafe-eval` is not strictly required. In production, nonce-based CSP is recommended.

---

### H1: PostHog Uses localStorage Persistence [HIGH]

**Severity:** H (High)
**File:** `apps/web/src/lib/posthog.ts:35`

**Evidence:**
```typescript
posthog.init(key, {
  persistence: 'localStorage',
  person_profiles: 'identified_only',
})
```

PostHog stores its `distinct_id`, feature flags, and super properties (including `ibx_session_id`) in localStorage. While `person_profiles: 'identified_only'` limits PII, the `ibx_session_id` is a cross-session identifier that can be read by any JS on the same origin. If PostHog `identify()` is added in Phase 2 (as planned in the docs), customer IDs will also land in localStorage.

**Recommendation:** Switch to `persistence: 'cookie'` with `secure: true` and `cross_subdomain_cookie: false` to keep PostHog data in cookies (which can be httpOnly-adjacent with proper flags). Alternatively, use `persistence: 'memory'` if cross-session persistence is not needed.

---

### H2: Error Boundaries Leak Raw error.message to Users [HIGH]

**Severity:** H (High)
**Files:**
- `apps/web/src/app/error.tsx:18` — `{error.message || "Erro inesperado..."}`
- `apps/web/src/app/[locale]/error.tsx:20` — same pattern
- `apps/web/src/app/[locale]/loja/error.tsx:14` — same pattern

**Evidence:** All three error boundary files render `error.message` directly into the UI. If an API error or runtime exception contains internal details (e.g., database connection strings, stack traces, SQL errors), these will be displayed to end users.

**Blast Radius:** Any unhandled error in the app tree could leak internal information to users.

**Recommendation:** Show only the generic fallback message to users. Log the full `error.message` + `error.digest` to an error tracking service (Sentry, PostHog errors, etc.) instead.

---

### H3: Admin apiFetch Missing x-admin-key Header [HIGH]

**Severity:** H (High)
**File:** `apps/admin/src/lib/api.ts:10-19`

**Evidence:**
```typescript
export const apiFetch = async (endpoint: string, options?: RequestInit) => {
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  })
}
```

The admin app's `apiFetch` never sends the `x-admin-key` header that the API server requires (`apps/api/src/routes/admin/index.ts:33`). This means **every admin API call will fail with 401/403 in production** (and likely in dev too, unless the API key check is also a dev stub).

Cross-reference: Confirmed by security-auditor finding.

**Blast Radius:** The entire admin panel is non-functional. No dashboard data, no product management, no order viewing.

---

### M1: Middleware JWT Decode Without Signature Verification [MEDIUM]

**Severity:** M (Medium)
**File:** `apps/web/src/middleware.ts:17-31`

**Evidence:**
```typescript
/**
 * Lightweight JWT decode + expiry check for Edge Runtime.
 * Does NOT verify signature (leave that to the API server).
 */
function isTokenExpired(token: string): boolean {
  const payload = JSON.parse(atob(parts[1]...))
  if (!payload.exp) return false
  return Date.now() >= payload.exp * 1000
}
```

The middleware only decodes the JWT payload to check expiry — it does not verify the signature. This is documented and intentional (Edge Runtime limitation), but it means:
- A crafted JWT with a valid-looking but forged payload bypasses the middleware.
- Protected routes (`/checkout`, `/conta`, `/pedido`) become accessible with any base64-encoded payload with a future `exp`.

**Mitigating Factor:** The comment says "leave that to the API server," meaning the API layer validates signatures. The middleware is a UX optimization (redirect to login), not a security gate. This is an acceptable pattern IF the API always validates.

---

### M2: apiStream Has No Abort/Cancellation Mechanism [MEDIUM]

**Severity:** M (Medium)
**File:** `apps/web/src/lib/api.ts:68-107`

**Evidence:** The `apiStream` function creates a fetch request but accepts no `AbortSignal`. If the chat component unmounts (user navigates away), the stream continues reading in the background until the server closes it. The `finally` block releases the reader lock, but the underlying fetch connection stays alive.

Similarly, `chat.hooks.ts:70` (`apiStream(...)`) has no way to cancel the stream if the user navigates away mid-conversation.

**Recommendation:** Accept an optional `AbortSignal` parameter and pass it to the `fetch` call.

---

### M3: Session Store Persists customerId to localStorage [MEDIUM]

**Severity:** M (Medium)
**File:** `apps/web/src/domains/session/session.store.ts:114-121`

**Evidence:**
```typescript
partialize: (state) => ({
  sessionId: state.sessionId,
  customerId: state.customerId,  // <-- persisted
  channel: state.channel,
  userType: state.userType,
})
```

The `customerId` is persisted to localStorage via Zustand's `persist` middleware. While permissions are intentionally excluded (line 119-120 comment), the customer ID itself is in localStorage. This is a mild data exposure — an attacker with physical access or XSS can read the customer ID.

**Mitigating Factor:** The store's `hydrate()` method validates the `customerId` against the server on load, so a tampered `customerId` would be corrected. The real auth is the httpOnly cookie.

---

### M4: Web App Has Admin Domain Code Shipped to Storefront Bundle [MEDIUM]

**Severity:** M (Medium)
**Files:**
- `apps/web/src/domains/admin/admin.hooks.ts`
- `apps/web/src/domains/admin/admin.factory.ts`
- `apps/web/src/components/molecules/AdminSidebar.tsx`

**Evidence:** The web storefront (`apps/web`) contains a full `admin` domain with hooks and an `AdminSidebar` component. This code ships to all storefront visitors as part of the JS bundle (unless tree-shaken, which depends on import paths). No deprecated admin routes exist under `apps/web/src/app/`, so this code appears to be dead/unreachable — but it inflates the bundle.

**Recommendation:** Remove admin domain code from `apps/web` now that `apps/admin` exists as a standalone app.

---

### L1: Hardcoded Strings in Loja Error Page [LOW]

**Severity:** L (Low)
**File:** `apps/web/src/app/[locale]/loja/error.tsx:12-14`

**Evidence:**
```tsx
<h2>Erro na loja</h2>
<p>{error.message || "Erro inesperado. Tente novamente."}</p>
<button>Tentar novamente</button>
```

Unlike the locale error.tsx which uses `useTranslations`, the loja error page hardcodes Portuguese strings. While the app only supports `pt-BR`, this diverges from the i18n pattern used elsewhere.

---

### L2: Chat Store Message History Unbounded in Memory [LOW]

**Severity:** L (Low)
**File:** `apps/web/src/domains/chat/chat.store.ts:32-33`

**Evidence:**
```typescript
addMessage: (message) =>
  set((state) => ({
    messages: [...state.messages, message].slice(-50),
  })),
```

The chat store caps at 50 messages via `.slice(-50)`. This is a reasonable limit. However, `updateLastMessage` appends to the last message's content without any size limit, meaning a single assistant response could grow unbounded in memory.

**Mitigating Factor:** The SSE stream will terminate, so this is bounded by the server's response length in practice.

---

### L3: Dual Analytics Session IDs [LOW]

**Severity:** L (Low)
**Files:**
- `apps/web/src/domains/analytics/track.ts:47-66` — analytics `sessionId` in sessionStorage
- `apps/web/src/domains/session/session.store.ts:39-53` — Zustand `sessionId` in localStorage

**Evidence:** Two independent session ID systems exist:
1. `track.ts` generates `ibx_analytics_session` in sessionStorage (per-tab, cleared on tab close)
2. `session.store.ts` generates a persistent `sessionId` in localStorage (survives tab close)

Both are registered with PostHog. The analytics session ID is used for RPS calculation, while the store session ID is used for API calls. This dual-ID system may cause correlation confusion in analytics dashboards.

---

## Cross-Agent Findings

| Source Agent | Finding | Relevance to Frontend |
|-------------|---------|----------------------|
| security-auditor | Admin `apiFetch()` never sends `x-admin-key` header | Confirmed as H3 above — admin panel entirely non-functional |
| security-auditor | Admin panel has no server-side auth | Confirmed as C1 above |
| ai-agent-auditor | SSE streams Map unbounded — memory leak (server-side) | Frontend `apiStream` has no cancellation mechanism (M2 above) |
| data-layer-auditor | No migration history (prisma db push) | No direct frontend impact |

---

## Shared UI Library (packages/ui)

`packages/ui` is imported by **both** apps:
- `apps/web`: 4 files import from `@ibatexas/ui` (admin hooks/factory, Modal, AdminSidebar)
- `apps/admin`: 12 files import from `@ibatexas/ui` (admin pages, hooks, sidebar, components)

The shared library follows atomic design (atoms/, molecules/, organisms/) and exports admin page components, hooks factory, and base UI atoms. This is working as intended — code is shared, not duplicated.

---

## Positive Findings

1. **Auth token handling is correct:** JWT is in httpOnly cookie, never exposed to JS. Zustand session store explicitly documents this pattern (session.store.ts:14).
2. **Analytics is well-architected:** Dual-channel delivery, lazy session_started firing, dedup guards, type-safe event union, comprehensive documentation.
3. **Error boundaries exist at multiple levels:** root, locale, and loja — providing graceful degradation.
4. **i18n is consistent:** Single locale `pt-BR` with `localePrefix: 'as-needed'`, next-intl used throughout.
5. **Cart store has good migration support:** `version: 4` with `migrateCartState` function for backward compatibility.
6. **Security headers are present:** X-Frame-Options, X-Content-Type-Options, Referrer-Policy all configured on both apps.
7. **Dynamic imports used for heavy client components:** CartDrawer, ChatWidget, StickyCartBar are loaded lazily.
8. **No deprecated admin routes in apps/web:** Clean separation between web and admin apps (though some admin domain code remains in web, see M4).
