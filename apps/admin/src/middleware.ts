import { NextResponse } from "next/server";

// Auth is handled by the admin layout (shows LoginForm when unauthenticated)
// and by the API proxy route (x-admin-key / staff JWT cookie).
// This middleware is a no-op passthrough.
export function middleware() {
  return NextResponse.next();
}
