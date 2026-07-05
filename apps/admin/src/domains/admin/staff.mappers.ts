// staff.mappers.ts — PURE view types + pt-BR label/format/plan/error helpers for
// the AUT-038 "Funcionários" admin surface: the OWNER-only staff-administration
// plane over the PR1 kernel-governed routes —
//   GET   /api/admin/staff              (list; role?/active? filters; pay data)
//   POST  /api/admin/staff              (create / reactivate an inactive phone)
//   PATCH /api/admin/staff/:id          (update name / phone / hourly rate — NOT role)
//   POST  /api/admin/staff/:id/deactivate
//   POST  /api/admin/staff/:id/role     (assign role — privilege escalation)
//
// Framework-free (no React) so the logic is trivially unit-testable in the repo's
// node vitest env. Money crosses the boundary as INTEGER centavos (Hard Rule #2)
// and is formatted via the shared @ibatexas/ui formatBRL (reused through the
// sibling customers.mappers display helpers, never re-declared). pt-BR throughout
// (Hard Rule #4). The `StaffMember` shape mirrors the server Staff row as it
// crosses JSON (dates are ISO strings) — a view read, not domain state, so not
// imported from @ibatexas/domain (a server package the browser bundle cannot pull).
//
// ── The honest-error contract (staffErrorText) ────────────────────────────────
// The staff routes carry pt-BR error text in TWO body shapes: the requireOwnerRole
// preHandler + Fastify/zod validation reply `{ error: "Forbidden"|"Bad Request",
// message: "<pt-BR>" }` (pt-BR in `message`), while the route handler's typed
// errors + kernel refusals reply `{ error: "<pt-BR>" }` (no `message`). Preferring
// `message` then `error` surfaces the pt-BR sentence in BOTH cases and never shows
// the bare English reason phrase (which only ever appears paired with a message).

import type { BadgeVariant } from '@ibatexas/ui/utils'
import { formatCentavosBRL, formatPhoneBR, orDash } from './customers.mappers'

// Re-export the reused display helpers so the page imports one module.
export { formatCentavosBRL, formatPhoneBR, orDash }
export type { BadgeVariant }

// ── Roles ─────────────────────────────────────────────────────────────────────

/** The closed staff-role set (mirrors the route's StaffRoleEnum). */
export type StaffRole = 'OWNER' | 'MANAGER' | 'ATTENDANT'

/** The role options an OWNER can pick, highest-privilege first. */
export const STAFF_ROLE_VALUES: readonly StaffRole[] = ['OWNER', 'MANAGER', 'ATTENDANT']

// ── Client mirror of a Staff row (JSON projection) ────────────────────────────

/** One staff member as the OWNER-gated list route returns it. */
export interface StaffMember {
  readonly id: string
  readonly phone: string
  readonly name: string
  readonly role: StaffRole
  readonly active: boolean
  readonly hourlyRateCentavos: number | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** The paginated list response `{ staff, total }`. */
export interface StaffListResponse {
  readonly staff: readonly StaffMember[]
  readonly total: number
}

// ── Endpoints / path builders (ids encoded defensively) ───────────────────────

export const STAFF_ENDPOINT = '/api/admin/staff'

/** PATCH target — update name / phone / hourly rate. */
export function staffUpdatePath(id: string): string {
  return `${STAFF_ENDPOINT}/${encodeURIComponent(id)}`
}

/** POST target — soft-deactivate (active = false). */
export function staffDeactivatePath(id: string): string {
  return `${STAFF_ENDPOINT}/${encodeURIComponent(id)}/deactivate`
}

/** POST target — assign role (privilege escalation). */
export function staffRolePath(id: string): string {
  return `${STAFF_ENDPOINT}/${encodeURIComponent(id)}/role`
}

// ── Role → pt-BR label + badge ────────────────────────────────────────────────

const ROLE_LABELS: Record<StaffRole, string> = {
  OWNER: 'Proprietário',
  MANAGER: 'Gerente',
  ATTENDANT: 'Atendente',
}

/** pt-BR role label; RAW value fallback for an unknown role (never blank). */
export function roleLabel(role: string): string {
  return ROLE_LABELS[role as StaffRole] ?? role
}

export interface StaffBadge {
  readonly label: string
  readonly variant: BadgeVariant
}

/**
 * Role → display badge. OWNER is the privilege-bearing role → blue `info`;
 * MANAGER / ATTENDANT are the ordinary bands → neutral `default`.
 */
export function roleBadge(role: StaffRole): StaffBadge {
  return role === 'OWNER'
    ? { label: ROLE_LABELS.OWNER, variant: 'info' }
    : { label: roleLabel(role), variant: 'default' }
}

/** Active → display badge. Active is the quiet default (green); inactive is neutral. */
export function activeBadge(active: boolean): StaffBadge {
  return active
    ? { label: 'Ativo', variant: 'success' }
    : { label: 'Inativo', variant: 'default' }
}

// ── Hourly rate (integer centavos → pt-BR BRL/hora) ───────────────────────────

/**
 * INTEGER-centavos hourly rate → "R$ 25,00/h". A null / unset rate renders the
 * em-dash (the rate is NULLABLE — a staff member with no rate is never guessed,
 * mirroring the domain-model note). Money via the shared formatBRL (Hard Rule #2).
 */
export function formatHourlyRate(centavos: number | null | undefined): string {
  if (centavos === null || centavos === undefined || !Number.isFinite(centavos)) {
    return '—'
  }
  return `${formatCentavosBRL(centavos)}/h`
}

/**
 * Parse an hourly-rate form field (reais) → INTEGER centavos, or null when the
 * field is empty / unparseable / negative. Accepts BR ("25,50") or plain
 * ("25.50", "25") decimals; thousands separators are NOT supported (hourly rates
 * are small). The page treats null as "no rate" (omit on create, clear on edit).
 */
export function parseReaisToCentavos(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  // Accept a comma OR dot as the decimal separator; reject anything else.
  const normalized = trimmed.replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null
  const reais = Number(normalized)
  if (!Number.isFinite(reais) || reais < 0) return null
  return Math.round(reais * 100)
}

/**
 * INTEGER centavos → the reais string used to PRE-FILL the edit form
 * ("2500" → "25,00"). A null / unset rate pre-fills empty (an owner clearing the
 * field then submits a rate-clearing update).
 */
export function centavosToReaisInput(centavos: number | null | undefined): string {
  if (centavos === null || centavos === undefined || !Number.isFinite(centavos)) {
    return ''
  }
  return (Math.trunc(centavos) / 100).toFixed(2).replace('.', ',')
}

// ── Create / edit form model + validation (pure) ──────────────────────────────

/** The create-staff form fields (role picked; rate optional, in reais). */
export interface CreateStaffForm {
  readonly name: string
  readonly phone: string
  readonly role: StaffRole
  readonly hourlyRateReais: string
}

/** The edit-staff form fields — NO role (role rides the assign-role action). */
export interface EditStaffForm {
  readonly name: string
  readonly phone: string
  readonly hourlyRateReais: string
}

/** Per-field pt-BR validation errors (absent key = valid field). */
export interface StaffFormErrors {
  readonly name?: string
  readonly phone?: string
  readonly hourlyRateReais?: string
}

/** Shared field checks — name non-empty, phone present, rate parseable-or-empty. */
function validateCommon(f: {
  readonly name: string
  readonly phone: string
  readonly hourlyRateReais: string
}): StaffFormErrors {
  const errors: {
    name?: string
    phone?: string
    hourlyRateReais?: string
  } = {}
  if (f.name.trim() === '') errors.name = 'Informe o nome do funcionário.'
  if (f.phone.trim() === '') errors.phone = 'Informe o telefone.'
  if (f.hourlyRateReais.trim() !== '' && parseReaisToCentavos(f.hourlyRateReais) === null) {
    errors.hourlyRateReais = 'Valor inválido (ex.: 25,00).'
  }
  return errors
}

/** Validate the create form; empty `errors` object ⇒ valid. */
export function validateCreateForm(f: CreateStaffForm): StaffFormErrors {
  return validateCommon(f)
}

/** Validate the edit form; empty `errors` object ⇒ valid. */
export function validateEditForm(f: EditStaffForm): StaffFormErrors {
  return validateCommon(f)
}

/** True when a validation-error object has no field entries. */
export function isFormValid(errors: StaffFormErrors): boolean {
  return Object.keys(errors).length === 0
}

// ── Request payload builders (assume validated input) ─────────────────────────

/** Create body. The rate is included only when set (server defaults to null). */
export interface CreateStaffPayload {
  readonly phone: string
  readonly name: string
  readonly role: StaffRole
  readonly hourlyRateCentavos?: number
}

export function buildCreatePayload(f: CreateStaffForm): CreateStaffPayload {
  const rate = parseReaisToCentavos(f.hourlyRateReais)
  return {
    phone: f.phone.trim(),
    name: f.name.trim(),
    role: f.role,
    ...(rate !== null ? { hourlyRateCentavos: rate } : {}),
  }
}

/**
 * Update body. name + phone + hourlyRateCentavos are ALWAYS sent (pre-filled from
 * the current row), which also satisfies the route's ≥1-field refine. An empty
 * rate field sends `null` — an explicit rate-clear. NEVER carries `role` (the
 * route `.strict()`-rejects it; role rides the assign-role action).
 */
export interface UpdateStaffPayload {
  readonly name: string
  readonly phone: string
  readonly hourlyRateCentavos: number | null
}

export function buildUpdatePayload(f: EditStaffForm): UpdateStaffPayload {
  return {
    name: f.name.trim(),
    phone: f.phone.trim(),
    hourlyRateCentavos: parseReaisToCentavos(f.hourlyRateReais),
  }
}

// ── Confirm copy (pt-BR) ──────────────────────────────────────────────────────

/** Deactivate confirm — a soft, reversible access removal (create reactivates). */
export const DEACTIVATE_CONFIRM = {
  title: 'Desativar funcionário?',
  body: 'O funcionário perde o acesso ao painel e às operações imediatamente. Nenhum registro é apagado — a escala e o histórico permanecem, e você pode reativá-lo criando-o novamente com o mesmo telefone.',
  confirmLabel: 'Desativar',
  cancelLabel: 'Cancelar',
} as const

/** Assign-role modal copy — a privilege change, so it warns before confirming. */
export const ASSIGN_ROLE_CONFIRM = {
  title: 'Alterar cargo',
  body: 'Alterar o cargo muda o nível de acesso deste funcionário. Proprietário tem acesso total (inclusive à administração de funcionários).',
  confirmLabel: 'Atribuir cargo',
  cancelLabel: 'Cancelar',
} as const

// ── Settled-mutation result (raw fetch reads the body on BOTH paths) ───────────

/** HTTP status + parsed body for a settled staff mutation (never throws). */
export interface StaffMutationResult {
  readonly ok: boolean
  readonly status: number
  readonly body: unknown
}

/** The four staff mutations, for action-specific honest toast copy. */
export type StaffAction = 'create' | 'update' | 'deactivate' | 'assign-role'

// ── Honest error text (message-first-then-error; see file header) ─────────────

/** Status-keyed pt-BR fallback when the body carries no usable text. */
export function staffErrorFallback(status: number): string {
  switch (status) {
    case 400:
      return 'Dados inválidos. Verifique os campos e tente novamente.'
    case 403:
      return 'Sem permissão — apenas o proprietário pode administrar funcionários.'
    case 404:
      return 'Funcionário não encontrado. Atualize a lista.'
    case 409:
      return 'Conflito ao salvar. Atualize a lista e tente novamente.'
    default:
      return 'Falha ao salvar. Tente novamente.'
  }
}

/**
 * The pt-BR error to show for a non-OK mutation: the server's own `message`, else
 * its `error`, else the status-keyed fallback. See the file header for why
 * `message` wins over `error` (the bare "Forbidden"/"Bad Request" reason phrase
 * only ever appears alongside a real pt-BR `message`).
 */
export function staffErrorText(body: unknown, status: number): string {
  const b = body as { message?: unknown; error?: unknown } | null | undefined
  const message = typeof b?.message === 'string' ? b.message.trim() : ''
  if (message) return message
  const error = typeof b?.error === 'string' ? b.error.trim() : ''
  if (error) return error
  return staffErrorFallback(status)
}

// ── Success toast copy (pt-BR, action-specific) ───────────────────────────────

const SUCCESS_MESSAGES: Record<StaffAction, string> = {
  create: 'Funcionário salvo.',
  update: 'Dados do funcionário atualizados.',
  deactivate: 'Funcionário desativado.',
  'assign-role': 'Cargo atualizado.',
}

/** pt-BR success toast for a settled (2xx) staff mutation. */
export function staffSuccessMessage(action: StaffAction): string {
  return SUCCESS_MESSAGES[action]
}

// ── Shared page copy (pt-BR) ──────────────────────────────────────────────────

export const STAFF_COPY = {
  title: 'Funcionários',
  subtitle: 'Administração de acesso e remuneração da equipe — somente o proprietário.',
  loadFailed: 'Falha ao carregar os funcionários.',
  networkError: 'Falha de conexão. Tente novamente.',
  empty: 'Nenhum funcionário encontrado.',
  forbidden: 'Sem permissão — apenas o proprietário pode administrar funcionários.',
  newStaff: 'Novo funcionário',
} as const
