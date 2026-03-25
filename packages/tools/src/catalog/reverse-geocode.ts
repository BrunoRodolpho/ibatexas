// reverse-geocode — converts GPS coordinates to a CEP via Nominatim.
// GEOCODING_API_URL defaults to Nominatim (public instance).
// Gracefully returns nulls on timeout, network error, or missing postcode.

export interface ReverseGeocodeResult {
  cep: string | null;
  formattedAddress: string | null;
}

export async function reverseGeocode(lat: number, lng: number): Promise<ReverseGeocodeResult> {
  const baseUrl = process.env.GEOCODING_API_URL ?? "https://nominatim.openstreetmap.org";
  const url = `${baseUrl}/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "IbateXas/1.0" },
    });
  } catch {
    return { cep: null, formattedAddress: null };
  }

  if (!res.ok) return { cep: null, formattedAddress: null };

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { cep: null, formattedAddress: null };
  }

  const record = data as Record<string, unknown>;
  const address = record?.address as Record<string, unknown> | undefined;
  const rawPostcode = typeof address?.postcode === "string" ? address.postcode : null;
  const cep = rawPostcode ? rawPostcode.replace(/\D/g, "") : null;
  const formattedAddress = typeof record?.display_name === "string" ? record.display_name : null;

  return { cep, formattedAddress };
}
