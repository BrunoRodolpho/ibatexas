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

export default function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  if (isProtectedPath(pathname)) {
    // Check for session token cookie (set by /api/auth/verify-otp)
    const token = request.cookies.get("token")?.value
    if (!token) {
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
  matcher: ["/((?!api|_next|.*\\..*).*)"],
}
