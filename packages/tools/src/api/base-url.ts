/**
 * Resolve the API base URL. On the server (SSR) we use the env var directly.
 * In the browser, if the configured URL points to localhost but the page is
 * being accessed from a LAN IP (e.g. mobile device testing), we swap to the
 * current hostname so the phone can actually reach the Mac's API server.
 */
export function getApiBase(): string {
  const g = globalThis as Record<string, unknown>
  if (!g["window"]) {
    return process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
  }
  const configured = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"
  try {
    const url = new URL(configured)
    const loc = g["location"] as { hostname: string } | undefined
    if (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      loc &&
      loc.hostname !== "localhost" &&
      loc.hostname !== "127.0.0.1"
    ) {
      url.hostname = loc.hostname
    }
    return url.origin
  } catch {
    return configured
  }
}

export const MEDUSA_ADMIN_URL = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000"
