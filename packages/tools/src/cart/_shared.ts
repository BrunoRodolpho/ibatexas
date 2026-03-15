// Shared Medusa Store API client for cart tools (packages/tools — no Fastify dependency)

const MEDUSA_URL = process.env.MEDUSA_URL ?? "http://localhost:9000";
const MEDUSA_PUBLISHABLE_KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? "";

export async function medusaStoreFetch(path: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(`${MEDUSA_URL}${path}`, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(10_000),
    headers: {
      "x-publishable-api-key": MEDUSA_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Medusa ${res.status}: ${text}`);
  }
  return res.json();
}

export async function medusaAdminFetch(path: string, options?: RequestInit): Promise<unknown> {
  const MEDUSA_API_KEY = process.env.MEDUSA_API_KEY ?? "";
  const res = await fetch(`${MEDUSA_URL}${path}`, {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(10_000),
    headers: {
      "Content-Type": "application/json",
      "x-medusa-access-token": MEDUSA_API_KEY,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Medusa admin ${res.status}: ${text}`);
  }
  return res.json();
}
