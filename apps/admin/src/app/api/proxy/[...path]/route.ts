import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const ALLOWED_PREFIXES = ["/api/admin/", "/api/auth/staff/"];

async function proxyRequest(request: NextRequest, params: { path: string[] }): Promise<NextResponse> {
  const path = params.path.join("/");
  // Admin hooks pass endpoints like "/api/admin/orders" (already prefixed with
  // "api/"), while the login form passes "auth/staff/send-otp" (bare). Normalize
  // so we don't end up with "/api/api/admin/orders" which would fail the
  // ALLOWED_PREFIXES check below.
  const targetPath = path.startsWith("api/") ? `/${path}` : `/api/${path}`;

  // SEC: Only allow proxying to admin API paths
  if (!ALLOWED_PREFIXES.some((prefix) => targetPath.startsWith(prefix))) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // S1 — the proxy NO LONGER injects the shared `x-admin-key`. That injection is
  // what let a forged, presence-only `staff_token` cookie ride the CLI key into
  // the key-eligible `staff/*` + `agents/*` groups (staff PII/pay + OWNER-account
  // creation) — a browser call must authenticate with a real staff JWT, which is
  // the API's DOM-001 boundary; the CLI reaches the API directly, not through this
  // proxy, so it is unaffected. This cookie check is now only an early UX bounce
  // for a logged-out browser (nicer than a raw upstream 401); it is presence-only
  // and NOT a security boundary — the API validates the JWT signature/expiry.
  // `/api/auth/staff/*` (OTP login) is exempt — no token exists yet at login time.
  if (targetPath.startsWith("/api/admin/")) {
    const cookieHeader = request.headers.get("cookie") ?? "";
    if (!/(?:^|;\s*)staff_token=/.test(cookieHeader)) {
      return NextResponse.json(
        { message: "Sessão expirada. Faça login novamente." },
        { status: 401 },
      );
    }
  }

  const url = new URL(targetPath, API_URL);
  url.search = request.nextUrl.search;

  const headers = new Headers();

  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
  }

  // Forward Idempotency-Key — refund step 1 (and other idempotent POSTs)
  // require it; the fresh Headers() above would otherwise strip it.
  const idempotencyKey = request.headers.get("idempotency-key");
  if (idempotencyKey) {
    headers.set("idempotency-key", idempotencyKey);
  }

  // Forward cookies for staff JWT auth
  const cookie = request.headers.get("cookie");
  if (cookie) {
    headers.set("cookie", cookie);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    const bodyText = await request.text();
    if (bodyText.length > 0) {
      init.body = bodyText;
    } else {
      // No body — strip content-type to avoid Fastify JSON parse error on ""
      headers.delete("content-type");
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), init);
  } catch (err) {
    // The upstream API is unreachable (down, crash-looping, or not yet booted).
    // Surface a legible 502 instead of letting the throw bubble up as a raw 500
    // stack trace — the login form reads `message`, and admin hooks see a clean
    // status code. pt-BR per Hard Rule #4 (user-facing text).
    console.error(`[admin-proxy] upstream fetch failed for ${targetPath}:`, err);
    return NextResponse.json(
      { message: "Serviço de API indisponível no momento. Tente novamente em instantes." },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  const upstreamContentType = upstream.headers.get("content-type");
  if (upstreamContentType) {
    responseHeaders.set("content-type", upstreamContentType);
  }

  // Forward Set-Cookie headers so the staff JWT reaches the browser
  const setCookies = upstream.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    responseHeaders.append("set-cookie", cookie);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, await context.params);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, await context.params);
}

export async function PUT(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, await context.params);
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, await context.params);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  return proxyRequest(request, await context.params);
}
