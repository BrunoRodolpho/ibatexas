/**
 * Centralized pt-BR label constants for admin organisms.
 *
 * All user-facing strings that appear in admin pages live here so they can
 * be maintained (and eventually translated) in a single place.
 */

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'pendente',
  confirmed: 'confirmado',
  preparing: 'preparando',
  ready: 'pronto',
  in_delivery: 'em entrega',
  delivered: 'entregue',
  canceled: 'cancelado',
  completed: 'concluído',
  requires_action: 'ação necessária',
}

export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  // New canonical payment statuses (from PaymentStatus enum)
  awaiting_payment: 'aguardando pagamento',
  payment_pending: 'pagamento pendente',
  payment_expired: 'pagamento expirado',
  payment_failed: 'pagamento falhou',
  cash_pending: 'dinheiro (pendente)',
  paid: 'pago',
  switching_method: 'trocando pagamento',
  partially_refunded: 'reembolso parcial',
  refunded: 'reembolsado',
  disputed: 'em disputa',
  canceled: 'cancelado',
  waived: 'isento',
  // Legacy Medusa statuses (backward compat during transition)
  captured: 'pago',
  pending: 'pendente',
  cash_on_delivery: 'dinheiro',
  cancelado: 'cancelado',
  requires_action: 'aç��o necessária',
  not_paid: 'não pago',
}

// ---------------------------------------------------------------------------
// Reservation status
// ---------------------------------------------------------------------------

export const RESERVATION_STATUS_LABELS: Record<string, string> = {
  pending: 'Pendente',
  confirmed: 'Confirmada',
  seated: 'Sentada',
  completed: 'Completa',
  cancelled: 'Cancelada',
  no_show: 'No Show',
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

export const ORDER_STATUS_FILTERS = [
  { id: '', label: 'Todos' },
  { id: 'pending', label: 'Pendente' },
  { id: 'confirmed', label: 'Confirmado' },
  { id: 'preparing', label: 'Preparando' },
  { id: 'ready', label: 'Pronto' },
  { id: 'in_delivery', label: 'Em Entrega' },
  { id: 'delivered', label: 'Entregue' },
  { id: 'canceled', label: 'Cancelado' },
] as const

export const ORDER_DATE_FILTERS = [
  { id: '', label: 'Todas' },
  { id: 'hoje', label: 'Hoje' },
  { id: 'semana', label: 'Esta Semana' },
  { id: 'fds', label: 'Fim de Semana' },
  { id: 'mes', label: 'Este Mes' },
] as const

export const RESERVATION_STATUS_FILTERS = [
  { id: '', label: 'Todos' },
  { id: 'pending', label: 'Pendente' },
  { id: 'confirmed', label: 'Confirmada' },
  { id: 'seated', label: 'Sentada' },
  { id: 'completed', label: 'Completa' },
  { id: 'cancelled', label: 'Cancelada' },
  { id: 'no_show', label: 'No Show' },
] as const

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
