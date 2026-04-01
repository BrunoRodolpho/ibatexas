import { NextRequest, NextResponse } from "next/server";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY ?? "";

const ALLOWED_PREFIXES = ["/api/admin/"];

async function proxyRequest(request: NextRequest, params: { path: string[] }): Promise<NextResponse> {
  const path = params.path.join("/");
  const targetPath = `/api/${path}`;

  // SEC: Only allow proxying to admin API paths
  if (!ALLOWED_PREFIXES.some((prefix) => targetPath.startsWith(prefix))) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const url = new URL(targetPath, API_URL);
  url.search = request.nextUrl.search;

  const headers = new Headers();
  headers.set("x-admin-key", ADMIN_API_KEY);

  const contentType = request.headers.get("content-type");
  if (contentType) {
    headers.set("content-type", contentType);
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
    init.body = await request.text();
  }

  const upstream = await fetch(url.toString(), init);

  const responseHeaders = new Headers();
  const upstreamContentType = upstream.headers.get("content-type");
  if (upstreamContentType) {
    responseHeaders.set("content-type", upstreamContentType);
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
