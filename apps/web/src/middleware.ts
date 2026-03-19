import createMiddleware from "next-intl/middleware"
import { routing } from "./i18n/routing"
import { type NextRequest, NextResponse } from "next/server"

const intlMiddleware = createMiddleware(routing)

// Routes that require authentication (after locale prefix)
const PROTECTED_PATHS = ["/checkout", "/conta", "/pedido"]

function isProtectedPath(pathname: string): boolean {
  // Strip locale prefix if present (e.g., /pt-BR/checkout → /checkout)
  const withoutLocale = pathname.replace(/^\/pt-BR/, "") || "/"
  return PROTECTED_PATHS.some((p) => withoutLocale === p || withoutLocale.startsWith(p + "/"))
}

/**
 * Lightweight JWT decode + expiry check for Edge Runtime.
 * Does NOT verify signature (leave that to the API server).
 * Only decodes the payload to check if `exp` claim has passed.
 */
function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return true
    const payload = JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/")))
    if (!payload.exp) return false // No exp claim — server must validate
    return Date.now() >= payload.exp * 1000
  } catch {
    return true // Malformed token
  }
}

export default function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  // Guard: skip intl rewriting for internal Next.js paths and static files
  if (pathname.startsWith("/_next") || pathname.startsWith("/api") || pathname.includes(".")) {
    return NextResponse.next()
  }

  if (isProtectedPath(pathname)) {
    // Check for session token cookie (set by /api/auth/verify-otp)
    const token = request.cookies.get("token")?.value
    if (!token || isTokenExpired(token)) {
      const locale = pathname.startsWith("/pt-BR") ? "/pt-BR" : ""
      const entrar = new URL(`${locale}/entrar`, request.url)
      entrar.searchParams.set("next", pathname)
      return NextResponse.redirect(entrar)
    }
  }

  return intlMiddleware(request)
}

export const config = {
  // Match all pathnames except for
  // - API routes
  // - Next.js internals (_next)
  // - Static files (favicon, images, etc.)
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
}
