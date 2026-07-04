// order-notes.mappers.ts — PURE view helpers for the OPS-013 order staff-notes
// LIST surface (VIEW-FIRST). Renders the READ-ONLY GET /api/admin/orders/:id/
// notes response ({ notes: [{ id, author, authorId, content, createdAt }] }) as
// pt-BR display rows threaded into the order-detail drawer (same pattern the
// drawer's paymentHistory prop uses). Framework-free (no React, no '@/'
// imports) so the logic is trivially unit-testable in the repo's node vitest
// env. NOTE: the endpoint does NOT expose the OrderNote model's is_internal
// flag, so the view carries the note's ACTOR (admin / system / cliente …) as its
// provenance tag rather than a fabricated internal badge. pt-BR (Hard Rule #4).

/** One raw note row as returned by GET /api/admin/orders/:id/notes. */
export interface AdminOrderNoteRaw {
  readonly id: string
  readonly author: string
  readonly authorId: string | null
  readonly content: string
  readonly createdAt: string
}

/** The READ-ONLY notes-list response shape. */
export interface AdminOrderNotesResponse {
  readonly notes: readonly AdminOrderNoteRaw[]
}

/**
 * One display-ready note row for the drawer — pure pre-formatted strings so the
 * drawer renders without any logic. Structurally matches the drawer's `notes`
 * prop element (packages/ui cannot import from apps/admin, so the shape is
 * duplicated there by structural typing, not a shared import).
 */
export interface AdminOrderNoteView {
  readonly id: string
  readonly authorLabel: string
  readonly formattedDate: string
  readonly content: string
}

// pt-BR labels for the OrderActor enum (admin / system / system_backfill /
// customer). Mirrors the drawer's own ACTOR_LABELS so a note's author reads the
// same as a status-history actor.
const ACTOR_LABELS: Record<string, string> = {
  admin: 'Admin',
  system: 'Sistema',
  system_backfill: 'Migração',
  customer: 'Cliente',
}

/** pt-BR label for a note's author (OrderActor); unknown / blank → em-dash. */
export function orderNoteAuthorLabel(author: string | null | undefined): string {
  const a = author?.trim()
  if (!a) return '—'
  return ACTOR_LABELS[a] ?? a
}

/** ISO → pt-BR date-time; a null / empty / unparseable value → em-dash. */
export function formatNoteTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('pt-BR')
}

/**
 * Map the notes response to display rows, preserving the endpoint's oldest-first
 * order. Tolerates a missing / blank `notes` (→ empty list). Each row is a bag
 * of pre-formatted pt-BR strings so the drawer stays a pure renderer.
 */
export function mapOrderNotes(
  res: AdminOrderNotesResponse | null | undefined,
): AdminOrderNoteView[] {
  const list = res?.notes ?? []
  return list.map((n) => ({
    id: n.id,
    authorLabel: orderNoteAuthorLabel(n.author),
    formattedDate: formatNoteTimestamp(n.createdAt),
    content: n.content,
  }))
}
