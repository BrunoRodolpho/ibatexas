'use client'

// Funcionários — the OWNER-only staff-administration surface (AUT-038 + AUT-007).
// Lists the team over the PR1 kernel-governed routes and drives the four
// mutations: create (or reactivate an inactive phone), edit (name / phone / hourly
// rate — NOT role), deactivate (confirm-gated soft removal), and assign-role
// (confirm-gated privilege change). EVERY route is OWNER-gated server-side; a
// non-owner (or a manager-scoped admin key) sees the honest "sem permissão" banner
// instead of a crash. Writes are reload-after-write (never optimistic); a non-OK
// response surfaces the server's OWN pt-BR error text (staffErrorText) inline in
// the modal — a failed write NEVER reads as success. All non-trivial logic
// (labels, badges, money/phone formatting, form validation, payload building,
// honest error copy) lives in the PURE staff.mappers module. pt-BR throughout
// (Hard Rule #4); money in integer centavos (Hard Rule #2).

import { useEffect, useState } from 'react'
import { UserCog, RefreshCw, Plus, Phone, DollarSign } from 'lucide-react'
import { Badge, Button, Card, Modal, useToast } from '@ibatexas/ui'
import { useAdminStaff } from '@/domains/admin/admin.hooks'
import {
  roleLabel,
  roleBadge,
  activeBadge,
  formatHourlyRate,
  formatPhoneBR,
  centavosToReaisInput,
  validateCreateForm,
  validateEditForm,
  isFormValid,
  buildCreatePayload,
  buildUpdatePayload,
  staffErrorText,
  staffSuccessMessage,
  STAFF_ROLE_VALUES,
  STAFF_COPY as COPY,
  DEACTIVATE_CONFIRM,
  ASSIGN_ROLE_CONFIRM,
  type StaffMember,
  type StaffRole,
  type StaffFormErrors,
  type StaffMutationResult,
} from '@/domains/admin/staff.mappers'

// ── Forbidden / empty / loading banner ─────────────────────────────────────────

function Banner({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="rounded-sm border border-dashed border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-sm text-smoke-400">
      {children}
    </div>
  )
}

// ── Small form primitives (match the border-smoke input language) ──────────────

const INPUT_CLASS =
  'w-full rounded-sm border border-smoke-200 bg-white px-3 py-2 text-sm text-charcoal-900 placeholder:text-smoke-400 focus:border-charcoal-300 focus:outline-none'

function FormRow({
  label,
  htmlFor,
  error,
  hint,
  children,
}: Readonly<{
  label: string
  htmlFor: string
  error?: string
  hint?: string
  children: React.ReactNode
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-charcoal-700">
        {label}
      </label>
      {children}
      {error ? (
        <span className="text-xs text-red-600">{error}</span>
      ) : hint ? (
        <span className="text-xs text-smoke-400">{hint}</span>
      ) : null}
    </div>
  )
}

function RoleSelect({
  id,
  value,
  onChange,
  disabled,
}: Readonly<{
  id: string
  value: StaffRole
  onChange: (role: StaffRole) => void
  disabled?: boolean
}>): React.JSX.Element {
  return (
    <select
      id={id}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as StaffRole)}
      className={INPUT_CLASS}
    >
      {STAFF_ROLE_VALUES.map((r) => (
        <option key={r} value={r}>
          {roleLabel(r)}
        </option>
      ))}
    </select>
  )
}

/** Red inline banner carrying the server's honest pt-BR error text (never a fake success). */
function ErrorNote({ message }: Readonly<{ message: string }>): React.JSX.Element {
  return (
    <div className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      {message}
    </div>
  )
}

function ModalFooter({
  busy,
  confirmLabel,
  cancelLabel = 'Cancelar',
  confirmVariant = 'primary',
  onCancel,
  onConfirm,
}: Readonly<{
  busy: boolean
  confirmLabel: string
  cancelLabel?: string
  confirmVariant?: 'primary' | 'danger'
  onCancel: () => void
  onConfirm: () => void
}>): React.JSX.Element {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
        {cancelLabel}
      </Button>
      <Button variant={confirmVariant} size="sm" isLoading={busy} onClick={onConfirm}>
        {confirmLabel}
      </Button>
    </div>
  )
}

// ── Staff row ──────────────────────────────────────────────────────────────────

function StaffRow({
  member,
  onEdit,
  onAssignRole,
  onDeactivate,
}: Readonly<{
  member: StaffMember
  onEdit: (m: StaffMember) => void
  onAssignRole: (m: StaffMember) => void
  onDeactivate: (m: StaffMember) => void
}>): React.JSX.Element {
  const role = roleBadge(member.role)
  const active = activeBadge(member.active)
  return (
    <Card className="flex flex-col gap-3 border border-smoke-200 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-charcoal-900">{member.name}</h3>
            <Badge variant={role.variant}>{role.label}</Badge>
            <Badge variant={active.variant}>{active.label}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-smoke-500">
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Phone className="h-3 w-3" aria-hidden />
              {formatPhoneBR(member.phone)}
            </span>
            <span className="inline-flex items-center gap-1 tabular-nums">
              <DollarSign className="h-3 w-3" aria-hidden />
              {formatHourlyRate(member.hourlyRateCentavos)}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => onEdit(member)}>
            Editar
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onAssignRole(member)}>
            Cargo
          </Button>
          {member.active ? (
            <Button variant="danger" size="sm" onClick={() => onDeactivate(member)}>
              Desativar
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  )
}

// ── Create modal ───────────────────────────────────────────────────────────────

function CreateStaffModal({
  onClose,
  submit,
  onSuccess,
}: Readonly<{
  onClose: () => void
  submit: (form: { name: string; phone: string; role: StaffRole; hourlyRateReais: string }) => Promise<StaffMutationResult>
  onSuccess: () => void
}>): React.JSX.Element {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState<StaffRole>('ATTENDANT')
  const [hourlyRateReais, setRate] = useState('')
  const [errors, setErrors] = useState<StaffFormErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onConfirm(): Promise<void> {
    const form = { name, phone, role, hourlyRateReais }
    const found = validateCreateForm(form)
    setErrors(found)
    if (!isFormValid(found)) return
    setServerError(null)
    setBusy(true)
    try {
      const result = await submit(form)
      if (result.ok) {
        onSuccess()
      } else {
        setServerError(staffErrorText(result.body, result.status))
      }
    } catch {
      setServerError(COPY.networkError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={COPY.newStaff}
      size="md"
      footer={
        <ModalFooter busy={busy} confirmLabel="Salvar" onCancel={onClose} onConfirm={onConfirm} />
      }
    >
      <div className="flex flex-col gap-3">
        {serverError ? <ErrorNote message={serverError} /> : null}
        <FormRow label="Nome" htmlFor="staff-create-name" error={errors.name}>
          <input
            id="staff-create-name"
            className={INPUT_CLASS}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome do funcionário"
          />
        </FormRow>
        <FormRow
          label="Telefone"
          htmlFor="staff-create-phone"
          error={errors.phone}
          hint="Formato internacional, ex.: +5511999999999"
        >
          <input
            id="staff-create-phone"
            className={INPUT_CLASS}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+5511999999999"
          />
        </FormRow>
        <FormRow label="Cargo" htmlFor="staff-create-role">
          <RoleSelect id="staff-create-role" value={role} onChange={setRole} disabled={busy} />
        </FormRow>
        <FormRow
          label="Remuneração por hora (opcional)"
          htmlFor="staff-create-rate"
          error={errors.hourlyRateReais}
          hint="Em reais, ex.: 25,00 — deixe em branco para não definir"
        >
          <input
            id="staff-create-rate"
            className={INPUT_CLASS}
            value={hourlyRateReais}
            onChange={(e) => setRate(e.target.value)}
            placeholder="25,00"
            inputMode="decimal"
          />
        </FormRow>
      </div>
    </Modal>
  )
}

// ── Edit modal (name / phone / hourly rate — NOT role) ─────────────────────────

function EditStaffModal({
  member,
  onClose,
  submit,
  onSuccess,
}: Readonly<{
  member: StaffMember
  onClose: () => void
  submit: (form: { name: string; phone: string; hourlyRateReais: string }) => Promise<StaffMutationResult>
  onSuccess: () => void
}>): React.JSX.Element {
  const [name, setName] = useState(member.name)
  const [phone, setPhone] = useState(member.phone)
  const [hourlyRateReais, setRate] = useState(centavosToReaisInput(member.hourlyRateCentavos))
  const [errors, setErrors] = useState<StaffFormErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onConfirm(): Promise<void> {
    const form = { name, phone, hourlyRateReais }
    const found = validateEditForm(form)
    setErrors(found)
    if (!isFormValid(found)) return
    setServerError(null)
    setBusy(true)
    try {
      const result = await submit(form)
      if (result.ok) {
        onSuccess()
      } else {
        setServerError(staffErrorText(result.body, result.status))
      }
    } catch {
      setServerError(COPY.networkError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Editar — ${member.name}`}
      size="md"
      footer={
        <ModalFooter busy={busy} confirmLabel="Salvar" onCancel={onClose} onConfirm={onConfirm} />
      }
    >
      <div className="flex flex-col gap-3">
        {serverError ? <ErrorNote message={serverError} /> : null}
        <FormRow label="Nome" htmlFor="staff-edit-name" error={errors.name}>
          <input
            id="staff-edit-name"
            className={INPUT_CLASS}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </FormRow>
        <FormRow
          label="Telefone"
          htmlFor="staff-edit-phone"
          error={errors.phone}
          hint="Formato internacional, ex.: +5511999999999"
        >
          <input
            id="staff-edit-phone"
            className={INPUT_CLASS}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </FormRow>
        <FormRow
          label="Remuneração por hora"
          htmlFor="staff-edit-rate"
          error={errors.hourlyRateReais}
          hint="Em reais, ex.: 25,00 — deixe em branco para remover"
        >
          <input
            id="staff-edit-rate"
            className={INPUT_CLASS}
            value={hourlyRateReais}
            onChange={(e) => setRate(e.target.value)}
            placeholder="25,00"
            inputMode="decimal"
          />
        </FormRow>
        <p className="text-xs text-smoke-400">
          O cargo é alterado pela ação “Cargo” (mudança de nível de acesso).
        </p>
      </div>
    </Modal>
  )
}

// ── Assign-role modal (privilege change — confirm-gated) ───────────────────────

function AssignRoleModal({
  member,
  onClose,
  submit,
  onSuccess,
}: Readonly<{
  member: StaffMember
  onClose: () => void
  submit: (role: StaffRole) => Promise<StaffMutationResult>
  onSuccess: () => void
}>): React.JSX.Element {
  const [role, setRole] = useState<StaffRole>(member.role)
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onConfirm(): Promise<void> {
    setServerError(null)
    setBusy(true)
    try {
      const result = await submit(role)
      if (result.ok) {
        onSuccess()
      } else {
        setServerError(staffErrorText(result.body, result.status))
      }
    } catch {
      setServerError(COPY.networkError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={ASSIGN_ROLE_CONFIRM.title}
      size="sm"
      footer={
        <ModalFooter
          busy={busy}
          confirmLabel={ASSIGN_ROLE_CONFIRM.confirmLabel}
          cancelLabel={ASSIGN_ROLE_CONFIRM.cancelLabel}
          onCancel={onClose}
          onConfirm={onConfirm}
        />
      }
    >
      <div className="flex flex-col gap-3">
        {serverError ? <ErrorNote message={serverError} /> : null}
        <p className="text-sm text-charcoal-700">
          <span className="font-semibold">{member.name}</span> — {ASSIGN_ROLE_CONFIRM.body}
        </p>
        <FormRow label="Cargo" htmlFor="staff-role-select">
          <RoleSelect id="staff-role-select" value={role} onChange={setRole} disabled={busy} />
        </FormRow>
      </div>
    </Modal>
  )
}

// ── Deactivate confirm modal ────────────────────────────────────────────────────

function DeactivateModal({
  member,
  onClose,
  submit,
  onSuccess,
}: Readonly<{
  member: StaffMember
  onClose: () => void
  submit: () => Promise<StaffMutationResult>
  onSuccess: () => void
}>): React.JSX.Element {
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onConfirm(): Promise<void> {
    setServerError(null)
    setBusy(true)
    try {
      const result = await submit()
      if (result.ok) {
        onSuccess()
      } else {
        setServerError(staffErrorText(result.body, result.status))
      }
    } catch {
      setServerError(COPY.networkError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={DEACTIVATE_CONFIRM.title}
      size="sm"
      footer={
        <ModalFooter
          busy={busy}
          confirmLabel={DEACTIVATE_CONFIRM.confirmLabel}
          cancelLabel={DEACTIVATE_CONFIRM.cancelLabel}
          confirmVariant="danger"
          onCancel={onClose}
          onConfirm={onConfirm}
        />
      }
    >
      <div className="flex flex-col gap-3">
        {serverError ? <ErrorNote message={serverError} /> : null}
        <p className="text-sm text-charcoal-700">
          <span className="font-semibold">{member.name}</span> — {DEACTIVATE_CONFIRM.body}
        </p>
      </div>
    </Modal>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────────

export default function FuncionariosPage(): React.JSX.Element {
  const { addToast } = useToast()
  const {
    staff,
    total,
    forbidden,
    loading,
    error,
    roleFilter,
    setRoleFilter,
    activeFilter,
    setActiveFilter,
    createStaff,
    updateStaff,
    deactivateStaff,
    assignRole,
    refetch,
  } = useAdminStaff()

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<StaffMember | null>(null)
  const [assigning, setAssigning] = useState<StaffMember | null>(null)
  const [deactivating, setDeactivating] = useState<StaffMember | null>(null)

  // Surface (never swallow) roster-load failures.
  useEffect(() => {
    if (error) {
      addToast({ type: 'error', message: COPY.loadFailed, dedupeKey: 'staff-list-load' })
    }
  }, [error, addToast])

  function afterWrite(action: Parameters<typeof staffSuccessMessage>[0], close: () => void): void {
    close()
    addToast({ type: 'success', message: staffSuccessMessage(action) })
    refetch()
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <UserCog className="mt-0.5 h-5 w-5 text-charcoal-700" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold text-charcoal-900">{COPY.title}</h1>
            <p className="text-sm text-smoke-500">{COPY.subtitle}</p>
          </div>
        </div>
        {!forbidden ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={refetch}
              className="flex items-center gap-1.5 rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1.5 text-xs font-medium text-charcoal-700 hover:bg-smoke-100"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Atualizar
            </button>
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {COPY.newStaff}
            </Button>
          </div>
        ) : null}
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      {!forbidden ? (
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value as StaffRole | '')}
            className="rounded-sm border border-smoke-200 bg-white px-3 py-1.5 text-sm text-charcoal-900 focus:border-charcoal-300 focus:outline-none"
            aria-label="Filtrar por cargo"
          >
            <option value="">Todos os cargos</option>
            {STAFF_ROLE_VALUES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <select
            value={activeFilter}
            onChange={(e) => setActiveFilter(e.target.value as '' | 'active' | 'inactive')}
            className="rounded-sm border border-smoke-200 bg-white px-3 py-1.5 text-sm text-charcoal-900 focus:border-charcoal-300 focus:outline-none"
            aria-label="Filtrar por situação"
          >
            <option value="active">Ativos</option>
            <option value="inactive">Inativos</option>
            <option value="">Todos</option>
          </select>
          {total > 0 ? (
            <span className="text-xs tabular-nums text-smoke-500">{total} funcionário(s)</span>
          ) : null}
        </div>
      ) : null}

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      {forbidden ? (
        <Banner>{COPY.forbidden}</Banner>
      ) : loading && staff.length === 0 ? (
        <Banner>Carregando…</Banner>
      ) : staff.length === 0 ? (
        <Banner>{COPY.empty}</Banner>
      ) : (
        <div className="flex flex-col gap-3">
          {staff.map((m) => (
            <StaffRow
              key={m.id}
              member={m}
              onEdit={setEditing}
              onAssignRole={setAssigning}
              onDeactivate={setDeactivating}
            />
          ))}
        </div>
      )}

      {/* ── Modals ──────────────────────────────────────────────────────────── */}
      {createOpen ? (
        <CreateStaffModal
          onClose={() => setCreateOpen(false)}
          submit={(form) => createStaff(buildCreatePayload(form))}
          onSuccess={() => afterWrite('create', () => setCreateOpen(false))}
        />
      ) : null}

      {editing ? (
        <EditStaffModal
          key={editing.id}
          member={editing}
          onClose={() => setEditing(null)}
          submit={(form) => updateStaff(editing.id, buildUpdatePayload(form))}
          onSuccess={() => afterWrite('update', () => setEditing(null))}
        />
      ) : null}

      {assigning ? (
        <AssignRoleModal
          key={assigning.id}
          member={assigning}
          onClose={() => setAssigning(null)}
          submit={(role) => assignRole(assigning.id, role)}
          onSuccess={() => afterWrite('assign-role', () => setAssigning(null))}
        />
      ) : null}

      {deactivating ? (
        <DeactivateModal
          key={deactivating.id}
          member={deactivating}
          onClose={() => setDeactivating(null)}
          submit={() => deactivateStaff(deactivating.id)}
          onSuccess={() => afterWrite('deactivate', () => setDeactivating(null))}
        />
      ) : null}
    </div>
  )
}
