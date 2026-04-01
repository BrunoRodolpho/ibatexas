import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // Allow public paths (login page, static assets)
  const publicPaths = ["/", "/login", "/_next", "/favicon.ico"];
  if (publicPaths.some((p) => request.nextUrl.pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check for staff auth cookie
  const staffToken = request.cookies.get("staff_token")?.value;
  if (!staffToken) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/proxy/:path*"],
};
