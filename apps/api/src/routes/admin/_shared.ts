// Shared helpers for Medusa API calls (admin + store)

import { UpstreamError } from "../../errors/upstream-error.js";

const MEDUSA_URL = process.env.MEDUSA_URL ?? "http://localhost:9000";
const MEDUSA_API_KEY = process.env.MEDUSA_API_KEY ?? "";
const MEDUSA_PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? "";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Fetch from Medusa Admin API (authenticated with x-medusa-access-token). */
export async function medusaAdmin(path: string, options?: RequestInit) {
  const url = `${MEDUSA_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      "x-medusa-access-token": MEDUSA_API_KEY,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[medusa-admin] ${res.status} ${path}: ${text}`);
    throw new UpstreamError("Medusa", res.status, text);
  }
  return res.json();
}

/** Fetch from Medusa Store API (authenticated with publishable key). */
export async function medusaStore(path: string, options?: RequestInit) {
  const url = `${MEDUSA_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    headers: {
      "x-publishable-api-key": MEDUSA_PUBLISHABLE_KEY,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[medusa-store] ${res.status} ${path}: ${text}`);
    throw new UpstreamError("Medusa", res.status, text);
  }
  return res.json();
}
