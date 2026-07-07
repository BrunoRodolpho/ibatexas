// WS5D — Análises was consolidated into the "Visão Geral" landing (WS5B) as a
// role-scoped section. This route now redirects, so existing bookmarks / deep
// links keep working. (Painel Operacional stays its own live-poll page by design.)

import { redirect } from 'next/navigation'

export default function AnalisesRedirect(): never {
  // S14 — carry a section marker so the landing OPENS the Análises section on
  // arrival, instead of dropping the deep-link on a collapsed/hidden section.
  redirect('/admin?section=analises')
}
