/**
 * Centralized pt-BR label constants for admin organisms.
 *
 * All user-facing strings that appear in admin pages live here so they can
 * be maintained (and eventually translated) in a single place.
 *
 * BKL-016 — the STATUS labels below are now sourced from the single owner,
 * `@ibatexas/types` (status-labels.ts): the STAFF (Title Case) registers plus the
 * admin-only non-core extensions. This normalizes admin's previously
 * internally-inconsistent badges (lowercase order labels next to Title-Case
 * reservations — already a bug) onto the one Title-Case staff voice.
 *
 * BKL-016 also claimed this made "drift-by-divergence structurally impossible
 * (the types exhaustiveness test)". F-58 measured that claim and it was FALSE
 * of this file: the exhaustiveness test pins the key-sets of the maps
 * `status-labels.ts` OWNS, and cannot see a label copied into this file at all
 * — which is exactly how the filter chips below drifted ("Em Entrega" vs the
 * SSOT's "Em entrega") while every gate stayed green. The claim is true of the
 * maps above, which spread the SSOT rather than restate it.
 *
 * It is now true of the chips too, but by a DIFFERENT mechanism than the one
 * BKL-016 named: F-58 removed the second copy, and F-70 made the surviving
 * derivation type-exact. See the chip note below for what that does and does
 * not enforce.
 */

import {
  ADMIN_ORDER_STATUS_EXTRA,
  ADMIN_PAYMENT_STATUS_EXTRA,
  FISCAL_STATUS_LABELS_PT,
  ORDER_STATUS_LABELS_PT,
  OrderFulfillmentStatus,
  PAYMENT_STATUS_LABELS_PT,
  RESERVATION_STATUS_LABELS_PT,
  ReservationStatus,
} from '@ibatexas/types'

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------

export const ORDER_STATUS_LABELS: Record<string, string> = {
  ...ORDER_STATUS_LABELS_PT,
  ...ADMIN_ORDER_STATUS_EXTRA,
}

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  ...PAYMENT_STATUS_LABELS_PT,
  ...ADMIN_PAYMENT_STATUS_EXTRA,
}

// ---------------------------------------------------------------------------
// Fiscal (NFC-e) status — NEW-014
// ---------------------------------------------------------------------------

export const FISCAL_STATUS_LABELS: Record<string, string> = {
  ...FISCAL_STATUS_LABELS_PT,
}

// ---------------------------------------------------------------------------
// Reservation status
// ---------------------------------------------------------------------------

export const RESERVATION_STATUS_LABELS: Record<string, string> = {
  ...RESERVATION_STATUS_LABELS_PT,
}

// ---------------------------------------------------------------------------
// Product type
// ---------------------------------------------------------------------------

export const PRODUCT_TYPE_LABELS: Record<string, string> = {
  food: 'Comida',
  frozen: 'Congelado',
  merchandise: 'Loja',
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export const STOCK_LABELS = {
  inStock: 'Em estoque',
  outOfStock: 'Sem estoque',
} as const

// ---------------------------------------------------------------------------
// Filter chips (id === '' means "all")
// ---------------------------------------------------------------------------

/**
 * F-58 — the STATUS chips DERIVE their label from the BKL-016 SSOT instead of
 * re-declaring it. Do not re-introduce a literal `label:` on a status chip.
 *
 * These arrays used to spell the label text out a second time, a few lines
 * below the SSOT-backed `ORDER_STATUS_LABELS` in this very file, and they had
 * already drifted: `in_delivery` rendered its badge as "Em entrega" (SSOT) and
 * its chip as "Em Entrega" on the SAME admin page. The drift was invisible —
 * `packages/ui` has NO test files, and the chip text is not reachable from the
 * `@ibatexas/types` exhaustiveness test, so a corrupted chip label passed the
 * whole `pnpm lint` gate byte-identically (measured: 0 errors both ways).
 *
 * Reading the label out of the record removes the second copy entirely, so
 * label divergence is not merely detected — there is no longer a second string
 * that could diverge.
 *
 * WHAT IS AND IS NOT ENFORCED — `packages/ui` has no test files, so tsc is the
 * ONLY gate here and it is worth being exact about its reach. Every line below
 * was measured by planting the case and reading the compiler, not assumed:
 *
 *   ENFORCED — a hand-written `{ id, label }` literal (F-70). Planting
 *   `{ id: 'ready', label: 'ZZZ_HANDWRITTEN' }` fails with exit 2:
 *   `Type '"ZZZ_HANDWRITTEN"' is not assignable to type '"Pendente" | ... |
 *   "Todos"'`. Under F-58 this compiled clean and the request not to do it was
 *   only a convention.
 *
 *   ENFORCED — MIS-PAIRING, which no earlier shape could catch.
 *   `{ id: 'ready', label: 'Pendente' }` is two REAL values in the wrong
 *   combination; it now fails with `Type '"Pendente"' is not assignable to
 *   type '"Pronto"'`.
 *
 *   ENFORCED — an id that is not a member of the register. Planting
 *   `chipFor(ORDER_STATUS_LABELS_PT, 'redy')` still fails (exit 2), though
 *   note the message DEGRADED versus F-58's shape: because `'redy'` is not a
 *   `keyof M`, `K` widens to the whole union and the error reads as a
 *   cross-product mismatch rather than F-58's direct
 *   `Did you mean '"ready"'?`. Still caught; just less legible.
 *
 *   NOT ENFORCED — COMPLETENESS. Nothing requires a `chipFor(...)` line to
 *   exist for every status, so adding a member to the enum and its register
 *   compiles clean here and silently ships a missing chip. This is unchanged
 *   from F-58; only the reason moved (it was the SUBSET-check `satisfies`
 *   then, it is the hand-listed call set now). A missing-chip gap is not a
 *   label drift, and closing it still needs a real exhaustiveness pin.
 *
 * F-70 is what made that possible: `status-labels.ts` used to annotate its
 * maps `Record<Status, string>`, which WIDENED every value to `string` and
 * erased the literals at the source. They are now declared
 * `as const satisfies Record<Status, string>` — the `satisfies` keeps the
 * exhaustiveness guarantee the annotation gave, while `as const` keeps the
 * literal types this file needs. The emitted JS is byte-identical.
 *
 * Chips are built with one `chipFor(...)` call per status rather than a
 * `.map()` over an id list. That is deliberate and load-bearing, not style:
 * `.map()` hands the callback the UNION of ids, so its result type is the
 * CROSS PRODUCT of every id with every label — which cannot be checked
 * against the paired union, and is precisely why F-58's shape could not
 * enforce pairing. One call per status instantiates the generic per id and
 * keeps each pair exact. It also keeps chip ORDER a deliberate, reviewable
 * fact here instead of silently inheriting the SSOT's declaration order.
 */

/** The union of exact (id, label) pairs a status register admits. */
type StatusChipOf<M extends Record<string, string>> = {
  readonly [K in keyof M]: { readonly id: K; readonly label: M[K] }
}[keyof M]

type StatusFilterChip<M extends Record<string, string>> =
  | typeof ALL_FILTER_CHIP
  | StatusChipOf<M>

/** The chip meaning "no filter" — not a status, so it owns its label. */
const ALL_FILTER_CHIP = { id: '', label: 'Todos' } as const

/** Pair a status id with its SSOT label. Generic per-id so the pair stays exact. */
function chipFor<M extends Record<string, string>, K extends keyof M>(
  labels: M,
  id: K,
): { readonly id: K; readonly label: M[K] } {
  return { id, label: labels[id] }
}

export const ORDER_STATUS_FILTERS: ReadonlyArray<
  StatusFilterChip<typeof ORDER_STATUS_LABELS_PT>
> = [
  ALL_FILTER_CHIP,
  chipFor(ORDER_STATUS_LABELS_PT, OrderFulfillmentStatus.PENDING),
  chipFor(ORDER_STATUS_LABELS_PT, OrderFulfillmentStatus.CONFIRMED),
  chipFor(ORDER_STATUS_LABELS_PT, OrderFulfillmentStatus.PREPARING),
  chipFor(ORDER_STATUS_LABELS_PT, OrderFulfillmentStatus.READY),
  chipFor(ORDER_STATUS_LABELS_PT, OrderFulfillmentStatus.IN_DELIVERY),
  chipFor(ORDER_STATUS_LABELS_PT, OrderFulfillmentStatus.DELIVERED),
  chipFor(ORDER_STATUS_LABELS_PT, OrderFulfillmentStatus.CANCELED),
]

export const ORDER_DATE_FILTERS = [
  { id: '', label: 'Todas' },
  { id: 'hoje', label: 'Hoje' },
  { id: 'semana', label: 'Esta Semana' },
  { id: 'fds', label: 'Fim de Semana' },
  { id: 'mes', label: 'Este Mes' },
] as const

/**
 * Same derivation as `ORDER_STATUS_FILTERS` above — see that note. These chips
 * had NOT drifted (all six matched the SSOT when F-58 measured them), and this
 * array currently has zero consumers; it is converted anyway so the file holds
 * one rule rather than one rule and one exception for the next author to copy.
 */
export const RESERVATION_STATUS_FILTERS: ReadonlyArray<
  StatusFilterChip<typeof RESERVATION_STATUS_LABELS_PT>
> = [
  ALL_FILTER_CHIP,
  chipFor(RESERVATION_STATUS_LABELS_PT, ReservationStatus.PENDING),
  chipFor(RESERVATION_STATUS_LABELS_PT, ReservationStatus.CONFIRMED),
  chipFor(RESERVATION_STATUS_LABELS_PT, ReservationStatus.SEATED),
  chipFor(RESERVATION_STATUS_LABELS_PT, ReservationStatus.COMPLETED),
  chipFor(RESERVATION_STATUS_LABELS_PT, ReservationStatus.CANCELLED),
  chipFor(RESERVATION_STATUS_LABELS_PT, ReservationStatus.NO_SHOW),
]

export const RATING_FILTERS = [
  { id: '', label: 'Todos' },
  { id: '5', label: '5' },
  { id: '4', label: '4' },
  { id: '3', label: '3' },
  { id: '2', label: '2' },
  { id: '1', label: '1' },
] as const

// ---------------------------------------------------------------------------
// Column headers — keyed by table domain
// ---------------------------------------------------------------------------

export const ORDER_COLUMN_HEADERS = {
  displayId: 'Pedido #',
  customer: 'Cliente',
  items: 'Itens',
  total: 'Total',
  status: 'Status',
  payment: 'Pagamento',
  date: 'Data',
  time: 'Hora',
  orderId: '#',
} as const

export const RESERVATION_DATE_FILTERS = [
  { id: '', label: 'Todas' },
  { id: 'hoje', label: 'Hoje' },
  { id: 'semana', label: 'Esta Semana' },
  { id: 'fds', label: 'Fim de Semana' },
  { id: 'mes', label: 'Este Mes' },
] as const

export const RESERVATION_COLUMN_HEADERS = {
  id: 'Reserva #',
  customer: 'Cliente',
  partySize: 'Pessoas',
  dateTime: 'Data/Hora',
  table: 'Mesa',
  status: 'Status',
} as const

export const PRODUCT_COLUMN_HEADERS = {
  name: 'Nome',
  category: 'Categoria',
  type: 'Tipo',
  variants: 'Variantes',
  status: 'Status',
  stock: 'Estoque',
} as const

export const VARIANT_COLUMN_HEADERS = {
  size: 'Tamanho',
  sku: 'SKU',
  price: 'Preço',
  stock: 'Estoque',
} as const

export const REVIEW_COLUMN_HEADERS = {
  stars: 'Estrelas',
  comment: 'Comentário',
  product: 'Produto',
  customer: 'Cliente',
  date: 'Data',
} as const

// ---------------------------------------------------------------------------
// Page titles and subtitles
// ---------------------------------------------------------------------------

export const PAGE_TITLES = {
  orders: 'Pedidos',
  ordersSubtitle: 'Gerenciamento de pedidos',
  reservations: 'Reservas',
  menu: 'Cardápio',
  shop: 'Loja',
  reviews: 'Avaliações',
  dashboard: 'Dashboard',
  dashboardSubtitle: 'Visão geral do dia',
  analytics: 'Análises',
  analyticsSubtitle: 'Métricas do dia',
  hours: 'Horários de Funcionamento',
  hoursSubtitle: 'Horários regulares, feriados e exceções',
  zones: 'Zonas de Entrega',
  zonesSubtitle: 'Gerenciar áreas e taxas de entrega',
  reservationsSubtitle: 'Gerenciamento de reservas',
  menuSubtitle: 'Produtos do cardápio',
  shopSubtitle: 'Produtos da loja',
  reviewsSubtitle: 'Avaliações de clientes',
  banner: 'Banner',
  bannerSubtitle: 'Texto do banner curvado na homepage',
} as const

// ---------------------------------------------------------------------------
// Dashboard stat labels
// ---------------------------------------------------------------------------

export const DASHBOARD_STAT_LABELS = {
  ordersToday: 'Pedidos hoje',
  revenueToday: 'Receita hoje',
  activeReservations: 'Reservas ativas',
  pendingEscalations: 'Escalações pendentes',
  recentOrders: 'Pedidos recentes',
} as const

// ---------------------------------------------------------------------------
// Common action labels
// ---------------------------------------------------------------------------

export const ACTION_LABELS = {
  edit: 'Editar',
  editInMedusa: 'Editar no Medusa',
  addProduct: '+ Adicionar produto',
  clearFilters: 'Limpar filtros',
  previous: 'Anterior',
  next: 'Próximo',
  checkin: 'Check-in',
  complete: 'Completar',
  cancelReservation: 'Cancelar',
  viewAll: 'Ver todos',
  variants: 'Variantes',
  confirmOrder: 'Confirmar',
  startPreparing: 'Preparar',
  markReady: 'Pronto',
  sendDelivery: 'Enviar',
  markDelivered: 'Entregue',
  cancelOrder: 'Cancelar',
  advanceStatus: 'Avançar',
  refresh: 'Atualizar',
  // Incidentes action bar
  acknowledge: 'Reconhecer',
  resolve: 'Resolver',
  escalateIncident: 'Escalar (pausar bot)',
  sendReply: 'Enviar',
} as const

// ---------------------------------------------------------------------------
// Search placeholders
// ---------------------------------------------------------------------------

export const SEARCH_PLACEHOLDERS = {
  products: 'Buscar produtos...',
} as const

// ---------------------------------------------------------------------------
// Empty state messages
// ---------------------------------------------------------------------------

export const EMPTY_STATES = {
  orders: 'Nenhum pedido encontrado',
  ordersToday: 'Nenhum pedido hoje',
  reservations: 'Nenhuma reserva encontrada',
  products: 'Nenhum produto encontrado',
  reviews: 'Nenhuma avaliação encontrada',
  variants: 'Nenhuma variante cadastrada',
  analytics: 'Sem dados disponíveis.',
  hours: 'Nenhum feriado ou exceção cadastrado.',
  hoursFiltered: 'Nenhum item encontrado para o filtro selecionado.',
  zones: 'Nenhuma zona de entrega cadastrada.',
  zonesFiltered: 'Nenhuma zona encontrada para o filtro selecionado.',
  incidents: 'Nenhum incidente aberto.',
  incidentsFiltered: 'Nenhum incidente com esses filtros.',
} as const

// ---------------------------------------------------------------------------
// Incidents (falhas de resposta automática)
// ---------------------------------------------------------------------------

export const INCIDENT_LABELS = {
  nav: 'Incidentes',
  navTitle: 'Falhas de resposta automática',
  pageTitle: 'Incidentes',
  pageSubtitle: 'Atendimentos sem resposta',
  // right-pane / drawer section heads + prompts
  selectPrompt: 'Selecione um incidente para ver os detalhes.',
  transcriptHeading: 'Transcrição',
  technicalDetails: 'Detalhes técnicos',
  historyHeading: 'Histórico',
  gapLine: '— sem resposta enviada —',
  gapDetail: 'IA não gerou resposta · cliente ficou no silêncio',
  gapCollapsed: (n: number) => `— sem resposta enviada — (${n} quedas)`,
  dropOfTotal: (n: number, total: number) => `queda ${n} de ${total}`,
  reopenedFrom: (ref: string, age: string) => `Reaberto de ${ref} (resolvido auto ${age})`,
  reopenedTag: 'reaberto',
  replyPlaceholder: 'responder ao cliente…',
  neverReturned: 'nunca retornou',
  autoResolvedDivider: (age: string) => `incidente resolvido automaticamente · ${age}`,
  deliveredMarker: '✓ entregue',
  // customerImpacted glance (§6)
  impactedSilence: '·silêncio',
  impactedNotice: '·aviso enviado',
  // drawer technical field labels
  fieldTurn: 'Turno',
  fieldDecision: 'Decisão',
  fieldDrops: 'Quedas',
  fieldChannel: 'Canal',
  fieldCustomer: 'Cliente',
  fieldSession: 'Sessão',
  fieldOpenedAt: 'Aberto em',
} as const

// Incident enum → pt-BR (status keyed by IncidentStatus, severity by IncidentSeverity)
export const INCIDENT_STATUS_LABELS: Record<string, string> = {
  OPEN: 'aberto',
  ACKNOWLEDGED: 'em atendimento',
  AUTO_RESOLVED: 'resolvido auto',
  RESOLVED: 'resolvido',
}

export const INCIDENT_SEVERITY_LABELS: Record<string, string> = {
  high: 'alta',
  medium: 'média',
  low: 'baixa',
}

// Cause: short Badge rótulo (§6) + the drawer explanation line
export const INCIDENT_CAUSE_LABELS: Record<string, string> = {
  empty_completion: 'sem resposta da IA',
  whitespace_only: 'resposta em branco',
  send_failed: 'falha no envio',
  retry_exhausted: 'envios esgotados',
  timeout: 'tempo esgotado',
  pause_read_error: 'erro interno (pausa)',
}

export const INCIDENT_CAUSE_EXPLANATIONS: Record<string, string> = {
  empty_completion: 'A IA não gerou nenhum texto para enviar.',
  whitespace_only: 'A IA gerou apenas espaços em branco.',
  send_failed: 'A resposta foi gerada, mas o envio ao WhatsApp falhou.',
  retry_exhausted: 'Todas as tentativas de envio falharam.',
  timeout: 'A IA não respondeu dentro do tempo limite.',
  pause_read_error: 'Falha ao verificar a pausa do atendimento (Redis indisponível) — o cliente ficou sem resposta.',
}

// Filter chips (id === '' means "all")
export const INCIDENT_STATUS_FILTERS = [
  { id: '', label: 'Todos' },
  { id: 'OPEN', label: 'Abertos' },
  { id: 'ACKNOWLEDGED', label: 'Em atendimento' },
  { id: 'RESOLVED', label: 'Resolvidos' },
] as const

export const INCIDENT_CAUSE_FILTERS = [
  { id: '', label: 'Todas' },
  { id: 'empty_completion', label: 'Sem resposta' },
  { id: 'whitespace_only', label: 'Em branco' },
  { id: 'send_failed', label: 'Falha no envio' },
  { id: 'timeout', label: 'Tempo' },
] as const

export const INCIDENT_SEVERITY_FILTERS = [
  { id: '', label: 'Todas' },
  { id: 'high', label: 'Alta' },
  { id: 'medium', label: 'Média' },
  { id: 'low', label: 'Baixa' },
] as const

export const INCIDENT_COLUMN_HEADERS = {
  severity: 'Gravidade',
  cause: 'Causa',
  customer: 'Cliente',
  channel: 'Canal',
  drops: 'Quedas',
  status: 'Status',
  age: 'Idade',
} as const

// Empty state (zero incidents, healthy default)
export const INCIDENT_EMPTY = {
  title: 'Nenhum incidente aberto.',
  subtitle: 'Todos os clientes estão recebendo resposta.',
} as const

// StatCard strip (§3)
export const INCIDENT_STAT_LABELS = {
  open: 'Abertos',
  openSub: 'agora',
  acknowledged: 'Em atendimento',
  acknowledgedSub: 'atribuídos',
  resolvedToday: 'Resolvidos hoje',
  resolvedSub: (auto: number, staff: number) => `auto: ${auto} · você: ${staff}`,
  avgTime: 'Tempo médio',
  avgTimeSub: 'últimas 24h',
} as const

// Storm digest banner (§5) — keyed off the rolling open-count window
export const INCIDENT_STORM = {
  headline: 'Possível instabilidade da IA',
  summary: (count: number, minutes: number, cause: string) =>
    `${count} incidentes abertos nos últimos ${minutes} min · causa principal: ${cause}`,
  acknowledgeAll: (n: number) => `Reconhecer todos (${n})`,
  filterByCause: 'Filtrar por esta causa',
  details: 'detalhes',
} as const

// Toasts (§2 / §4). The reply toasts are reused from the escalações flow.
export const INCIDENT_TOASTS = {
  newTitle: 'Incidente aberto',
  newBody: 'Cliente sem resposta no WhatsApp',
  stormTitle: 'Possível instabilidade da IA',
  stormBody: (count: number, minutes: number, cause: string) =>
    `${count} incidentes abertos em ${minutes} min · causa principal: ${cause}`,
  acknowledged: 'Incidente reconhecido',
  resolved: 'Incidente resolvido',
  autoResolvedRace: 'Este incidente já foi resolvido automaticamente.',
  changedByOther: 'Incidente atualizado por outro atendente. Atualize a página.',
  invalidTransition: 'Transição de status inválida.',
  replyDelivered: 'Enviado ao cliente.',
  replyRecorded: 'Registrado (não entregue ao vivo).',
  replyFailed: 'Falha ao enviar a resposta.',
  loadFailed: 'Falha ao carregar os incidentes.',
} as const

// Resolver / Escalar confirmation copy (§4)
export const INCIDENT_CONFIRM = {
  resolveTitle: 'Marcar como resolvido?',
  resolveBody: 'Confirme que o cliente já foi atendido.',
  escalateTitle: 'Escalar e pausar o bot?',
  escalateBody: 'O atendimento passa para uma pessoa e o bot para de responder nesta conversa.',
  confirm: 'Confirmar',
  cancel: 'Cancelar',
} as const

// ---------------------------------------------------------------------------
// Miscellaneous inline templates / prefixes
// ---------------------------------------------------------------------------

export const MISC_LABELS = {
  errorPrefix: 'Erro:',
  itemCount: (n: number) => `${n} item(s)`,
  sizeCount: (n: number) => `${n} tamanho(s)`,
  pageOf: (current: number, total: number) => `Página ${current} de ${total}`,
} as const
