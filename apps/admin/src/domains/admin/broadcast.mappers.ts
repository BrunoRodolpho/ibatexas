// broadcast.mappers.ts — PURE view helpers for the OPS-032 broadcast opt-out
// LIST surface (VIEW-FIRST). Renders the READ-ONLY GET /api/admin/broadcast/
// optout response ({ recipients: string[] } — the WhatsApp recipient phone
// strings the blast skips) as a manager-visible, phone-formatted list.
// Framework-free (no React, no '@/' imports) so the logic is trivially
// unit-testable in the repo's node vitest env. Phone display REUSES the
// canonical formatPhoneBR from customers.mappers — the Clientes page formats
// recipient phones the exact same way (single source, never re-declared).
// pt-BR throughout (Hard Rule #4).

import { formatPhoneBR } from './customers.mappers'

/** The READ-ONLY GET /api/admin/broadcast/optout response shape. */
export interface BroadcastOptOutResponse {
  readonly recipients: readonly string[]
}

/**
 * One display row of the opted-out list: the raw recipient (stable list key +
 * round-trip identity, since E.164 is unique per recipient) alongside its
 * humane pt-BR phone rendering.
 */
export interface OptOutRecipientView {
  readonly recipient: string
  readonly display: string
}

/**
 * Map the opt-out response to display rows, formatting each recipient phone
 * with the canonical BR formatter. Tolerates a missing / blank `recipients`
 * (→ empty list) and skips blank entries so the rendered count never
 * over-reports.
 */
export function mapOptOutRecipients(
  res: BroadcastOptOutResponse | null | undefined,
): OptOutRecipientView[] {
  const list = res?.recipients ?? []
  return list
    .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    .map((recipient) => ({ recipient, display: formatPhoneBR(recipient) }))
}
