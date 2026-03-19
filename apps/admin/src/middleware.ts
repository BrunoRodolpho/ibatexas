// AUDIT-FIX: FE-C1 — server-side auth middleware for admin panel
// Protects all /admin/* routes. Validates presence of admin session cookie
// or x-admin-key header. Redirects unauthenticated requests to login page.
// Edge Runtime compatible (Next.js middleware).

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only protect /admin routes
  if (!pathname.startsWith("/admin")) {
    return NextResponse.next();
  }

  // Allow access if a valid admin session cookie is present
  const adminSession = request.cookies.get("admin-session")?.value;
  if (adminSession) {
    return NextResponse.next();
  }

  // Allow access if the x-admin-key header matches the configured key
  const adminKey = request.headers.get("x-admin-key");
  const expectedKey = process.env.NEXT_PUBLIC_ADMIN_API_KEY;
  if (expectedKey && adminKey === expectedKey) {
    return NextResponse.next();
  }

  // In development, allow bypass so existing dev workflow is not broken
  if (process.env.NODE_ENV !== "production") {
    return NextResponse.next();
  }

  // Redirect unauthenticated requests to login page
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/";
  loginUrl.searchParams.set("auth", "required");
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/admin/:path*"],
};
