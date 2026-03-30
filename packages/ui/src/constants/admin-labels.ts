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
  delivered: 'entregue',
  canceled: 'cancelado',
  completed: 'concluído',
  requires_action: 'ação necessária',
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
  { id: 'delivered', label: 'Entregue' },
  { id: 'canceled', label: 'Cancelado' },
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

export const RESERVATION_COLUMN_HEADERS = {
  id: 'ID',
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
  viewAll: 'Ver todos',
  variants: 'Variantes',
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
