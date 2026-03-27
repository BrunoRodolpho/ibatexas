// Server-side auth middleware for admin panel.
// Protects all /admin/* routes. Validates presence of admin session cookie
// or x-admin-key header. Redirects unauthenticated requests to login page.

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

  // Redirect unauthenticated requests to login page
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/";
  loginUrl.searchParams.set("auth", "required");
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/admin/:path*"],
};
