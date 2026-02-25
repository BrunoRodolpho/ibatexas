// Shared helpers for admin routes

const MEDUSA_URL = process.env.MEDUSA_URL ?? "http://localhost:9000";
const MEDUSA_API_KEY = process.env.MEDUSA_API_KEY ?? "";

export async function medusaAdmin(path: string, options?: RequestInit) {
  const url = `${MEDUSA_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-medusa-access-token": MEDUSA_API_KEY,
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Medusa admin error ${res.status}: ${text}`);
  }
  return res.json();
}
