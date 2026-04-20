/**
 * Format a numeric display ID into the user-facing IBX-XXXX format.
 * Used across web, admin, WhatsApp notifications, and API responses.
 */
export function formatOrderId(displayId: number): string {
  return `IBX-${String(displayId).padStart(4, "0")}`
}
