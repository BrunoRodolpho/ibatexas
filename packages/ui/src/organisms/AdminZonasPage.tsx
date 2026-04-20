'use client'

import { useState, useEffect, useMemo } from 'react'
import { MapPin, Plus, Trash2, Pencil, Search, Clock, DollarSign, X } from 'lucide-react'
import { PageHeader } from '../atoms/PageHeader'
import { PageSkeleton } from '../atoms/PageSkeleton'
import { EmptyState } from '../atoms/EmptyState'
import { ErrorBanner } from '../atoms/ErrorBanner'
import { PageShell } from '../layouts/PageShell'
import { FilterChip } from '../molecules/FilterChip'
import { FilterBar } from '../molecules/FilterBar'
import { PAGE_TITLES, EMPTY_STATES } from '../constants/admin-labels'

function formatPrice(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/** Parse a comma-separated CEP input. Accepts 5-digit prefixes or full 8-digit CEPs — stored as-is. */
function parseCepInput(input: string): { ceps: string[]; invalid: string[] } {
  const parts = input.split(',').map((c) => c.trim()).filter(Boolean)
  const ceps: string[] = []
  const invalid: string[] = []
  for (const p of parts) {
    const digits = p.replace(/[^0-9]/g, '')
    if (digits.length === 5 || digits.length === 8) {
      ceps.push(digits)
    } else {
      invalid.push(p)
    }
  }
  return { ceps: [...new Set(ceps)], invalid }
}

/** Format CEP for display: 14815001 → 14815-001, 14815 stays as-is */
function formatCep(cep: string): string {
  return cep.length === 8 ? `${cep.slice(0, 5)}-${cep.slice(5)}` : cep
}

interface DeliveryZone {
  id: string
  name: string
  cepPrefixes: string[]
  feeInCentavos: number
  estimatedMinutes: number
  active: boolean
}

const emptyZone = (): Omit<DeliveryZone, 'id'> => ({
  name: '',
  cepPrefixes: [],
  feeInCentavos: 0,
  estimatedMinutes: 60,
  active: true,
})

export interface AdminZonasPageProps {
  apiBase: string
}

export function AdminZonasPage({ apiBase }: Readonly<AdminZonasPageProps>) {
  const [zones, setZones] = useState<DeliveryZone[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<Omit<DeliveryZone, 'id'>>(emptyZone())
  const [cepInput, setCepInput] = useState('')
  const [saving, setSaving] = useState(false)

  // Search/filter
  const [nameQuery, setNameQuery] = useState('')
  const [cepQuery, setCepQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'' | 'active' | 'inactive'>('')

  async function loadZones() {
    try {
      const res = await fetch(`${apiBase}/api/admin/delivery-zones`, { credentials: 'include' })
      if (!res.ok) throw new Error('Erro ao carregar zonas')
      const data = await res.json() as { zones: DeliveryZone[] }
      setZones(data.zones)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar zonas')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadZones() }, [])

  // ── CEP validation ────────────────────────────────────────────────

  /** Check which CEPs from the input are already assigned to other zones. */
  function findDuplicateCeps(prefixes: string[], excludeZoneId?: string): Array<{ cep: string; zoneName: string }> {
    const dupes: Array<{ cep: string; zoneName: string }> = []
    for (const zone of zones) {
      if (zone.id === excludeZoneId) continue
      for (const cep of prefixes) {
        if (zone.cepPrefixes.includes(cep)) {
          dupes.push({ cep, zoneName: zone.name })
        }
      }
    }
    return dupes
  }

  const { ceps: parsedCeps, invalid: invalidCeps } = useMemo(() => parseCepInput(cepInput), [cepInput])
  const duplicateCeps = useMemo(() => findDuplicateCeps(parsedCeps, editingId ?? undefined), [parsedCeps, zones, editingId])
  const hasValidationErrors = invalidCeps.length > 0 || duplicateCeps.length > 0

  // ── Handlers ──────────────────────────────────────────────────────

  function openCreate() {
    setForm(emptyZone())
    setCepInput('')
    setEditingId(null)
    setCreating(true)
    setError(null)
  }

  function openEdit(zone: DeliveryZone) {
    setForm({
      name: zone.name,
      cepPrefixes: zone.cepPrefixes,
      feeInCentavos: zone.feeInCentavos,
      estimatedMinutes: zone.estimatedMinutes,
      active: zone.active,
    })
    setCepInput(zone.cepPrefixes.map(formatCep).join(', '))
    setEditingId(zone.id)
    setCreating(false)
    setError(null)
  }

  function cancelEdit() {
    setCreating(false)
    setEditingId(null)
    setError(null)
  }

  async function handleSave() {
    if (hasValidationErrors) return
    if (parsedCeps.length === 0) {
      setError('Informe ao menos um CEP valido (5 digitos para prefixo ou 8 digitos para CEP completo).')
      return
    }
    setSaving(true)
    setError(null)
    const payload = { ...form, cepPrefixes: parsedCeps }
    try {
      const url = editingId
        ? `${apiBase}/api/admin/delivery-zones/${editingId}`
        : `${apiBase}/api/admin/delivery-zones`
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        let detail = 'Erro ao salvar zona'
        try { const b = await res.json() as Record<string, string>; detail = b.message ?? b.error ?? detail } catch { /* */ }
        throw new Error(detail)
      }
      setEditingId(null)
      setCreating(false)
      await loadZones()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Excluir esta zona de entrega?')) return
    try {
      await fetch(`${apiBase}/api/admin/delivery-zones/${id}`, { method: 'DELETE', credentials: 'include' })
      await loadZones()
    } catch { setError('Erro ao excluir zona') }
  }

  // ── Filtered zones ────────────────────────────────────────────────

  const filteredZones = useMemo(() => {
    let list = zones
    if (statusFilter === 'active') list = list.filter((z) => z.active)
    else if (statusFilter === 'inactive') list = list.filter((z) => !z.active)
    if (nameQuery.trim()) {
      const q = nameQuery.toLowerCase()
      list = list.filter((z) => z.name.toLowerCase().includes(q))
    }
    if (cepQuery.trim()) {
      const q = cepQuery.replace(/[^0-9]/g, '')
      if (q) list = list.filter((z) => z.cepPrefixes.some((c) => c.includes(q)))
    }
    return list
  }, [zones, statusFilter, nameQuery, cepQuery])

  // ── Inline form (shared between create and inline-edit) ───────────

  function renderForm() {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label htmlFor="zone-name" className="block text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-1">Nome</label>
            <input id="zone-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Ex: Zona Sul"
              className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
          </div>
          <div className="col-span-2">
            <label htmlFor="zone-cep" className="block text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-1">
              CEPs (prefixo 5 digitos ou completo 8 digitos, separados por virgula)
            </label>
            <input id="zone-cep" value={cepInput} onChange={(e) => setCepInput(e.target.value)} placeholder="14815, 14815001, 14815-001"
              className={`w-full rounded-sm border px-3 py-2 text-sm focus:outline-none ${
                hasValidationErrors ? 'border-accent-red/40 focus:border-accent-red' : 'border-smoke-200 focus:border-brand-500'
              }`} />
            {cepInput && (
              <div className="mt-1.5 space-y-1">
                {parsedCeps.length > 0 && (
                  <p className="text-xs text-accent-green">
                    CEPs: {parsedCeps.map(formatCep).join(', ')}
                  </p>
                )}
                {invalidCeps.length > 0 && (
                  <p className="text-xs text-accent-red">
                    Formato invalido (use 5 ou 8 digitos): {invalidCeps.join(', ')}
                  </p>
                )}
                {duplicateCeps.length > 0 && (
                  <p className="text-xs text-accent-red">
                    CEP ja usado em outra zona: {duplicateCeps.map((d) => `${formatCep(d.cep)} (${d.zoneName})`).join(', ')}
                  </p>
                )}
              </div>
            )}
          </div>
          <div>
            <label htmlFor="zone-fee" className="block text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-1">Taxa (R$)</label>
            <input id="zone-fee" type="number" step="0.01" value={form.feeInCentavos / 100}
              onChange={(e) => setForm((f) => ({ ...f, feeInCentavos: Math.round(Number.parseFloat(e.target.value || '0') * 100) }))}
              className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
          </div>
          <div>
            <label htmlFor="zone-time" className="block text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-1">Prazo (min)</label>
            <input id="zone-time" type="number" value={form.estimatedMinutes}
              onChange={(e) => setForm((f) => ({ ...f, estimatedMinutes: Number.parseInt(e.target.value || '60', 10) }))}
              className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <input type="checkbox" id="zone-active" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} className="rounded border-smoke-300" />
            <label htmlFor="zone-active" className="text-sm text-charcoal-700">Ativa</label>
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving || !form.name || hasValidationErrors}
            className="rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 transition-colors">
            {saving ? 'Salvando...' : 'Salvar'}
          </button>
          <button onClick={cancelEdit}
            className="rounded-sm border border-smoke-200 px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:border-smoke-300 transition-colors">
            Cancelar
          </button>
        </div>
      </div>
    )
  }

  return (
    <PageShell>
      <PageHeader
        icon={MapPin}
        title={PAGE_TITLES.zones}
        subtitle={PAGE_TITLES.zonesSubtitle}
        action={
          <button onClick={openCreate} disabled={creating || editingId !== null} className="flex items-center gap-2 rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 transition-colors">
            <Plus className="h-4 w-4" /> Nova zona
          </button>
        }
      />

      {/* Create form — shown at top */}
      {creating && (
        <div className="rounded-sm border border-brand-200 bg-brand-50/50 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-charcoal-900">Nova zona de entrega</h2>
          {renderForm()}
        </div>
      )}

      {/* Stats + Search + filters */}
      {!loading && zones.length > 0 && (
        <div className="space-y-3">
          {/* Summary stats */}
          <div className="flex items-center gap-4 text-xs text-[var(--color-text-secondary)]">
            <span>{zones.length} {zones.length === 1 ? 'zona' : 'zonas'}</span>
            <span className="text-smoke-300">·</span>
            <span>{zones.filter((z) => z.active).length} ativas</span>
            <span className="text-smoke-300">·</span>
            <span>{new Set(zones.flatMap((z) => z.cepPrefixes)).size} CEPs cobertos</span>
          </div>
          {/* Filters + search */}
          <FilterBar>
            <FilterChip id="z-all" label="Todas" selected={statusFilter === ''} onToggle={() => setStatusFilter('')} />
            <FilterChip id="z-active" label="Ativas" selected={statusFilter === 'active'} onToggle={() => setStatusFilter(statusFilter === 'active' ? '' : 'active')} />
            <FilterChip id="z-inactive" label="Inativas" selected={statusFilter === 'inactive'} onToggle={() => setStatusFilter(statusFilter === 'inactive' ? '' : 'inactive')} />
            <div className="flex items-center gap-2 ml-auto">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-smoke-400" />
                <input type="text" value={nameQuery} onChange={(e) => setNameQuery(e.target.value)} placeholder="Nome..."
                  className="w-32 rounded-sm border border-smoke-200 bg-smoke-50 pl-8 pr-3 py-1.5 text-sm text-charcoal-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
              </div>
              <div className="relative">
                <MapPin className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-smoke-400" />
                <input type="text" value={cepQuery} onChange={(e) => setCepQuery(e.target.value)} placeholder="CEP..."
                  className="w-28 rounded-sm border border-smoke-200 bg-smoke-50 pl-8 pr-3 py-1.5 text-sm text-charcoal-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
              </div>
            </div>
          </FilterBar>
        </div>
      )}

      {loading && <PageSkeleton variant="spinner" />}
      {!loading && zones.length === 0 && (
        <EmptyState icon={MapPin} title={EMPTY_STATES.zones} subtitle="Clique em &quot;Nova zona&quot; para começar." />
      )}
      {!loading && filteredZones.length === 0 && zones.length > 0 && (
        <EmptyState title={EMPTY_STATES.zonesFiltered} />
      )}
      {!loading && filteredZones.length > 0 && (
        <div className="space-y-3">
          {filteredZones.map((zone) => (
            <div key={zone.id} className={`rounded-sm border transition-colors ${
              editingId === zone.id
                ? 'border-brand-200 bg-brand-50/50'
                : zone.active ? 'border-smoke-200 bg-white' : 'border-smoke-200 bg-smoke-50/50'
            } p-4`}>
              {editingId === zone.id ? (
                /* ── Inline edit mode ── */
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-sm font-semibold text-charcoal-900">Editando — {zone.name}</h2>
                    <button onClick={cancelEdit} className="p-1 rounded-sm hover:bg-smoke-200 text-[var(--color-text-secondary)] transition-colors" title="Cancelar">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  {renderForm()}
                </div>
              ) : (
                /* ── Display mode ── */
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2.5">
                    {/* Name + status */}
                    <div className="flex items-center gap-2.5">
                      <span className={`h-2 w-2 rounded-full flex-shrink-0 ${zone.active ? 'bg-accent-green' : 'bg-smoke-300'}`} />
                      <span className="font-medium text-charcoal-900">{zone.name}</span>
                      {!zone.active && (
                        <span className="text-[10px] font-medium uppercase tracking-wider rounded-full bg-smoke-200 px-2 py-0.5 text-[var(--color-text-secondary)]">Inativa</span>
                      )}
                    </div>
                    {/* Fee + time badges */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-sm bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
                        <DollarSign className="h-3 w-3" />
                        {formatPrice(zone.feeInCentavos)}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-sm bg-smoke-100 px-2 py-0.5 text-xs font-medium text-charcoal-600">
                        <Clock className="h-3 w-3" />
                        {zone.estimatedMinutes} min
                      </span>
                    </div>
                    {/* CEP chips */}
                    {zone.cepPrefixes.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {zone.cepPrefixes.map((cep) => (
                          <span key={cep} className="inline-block rounded-sm bg-smoke-100 px-1.5 py-0.5 text-[11px] font-mono text-charcoal-600">
                            {formatCep(cep)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-smoke-400 italic">Nenhum CEP atribuido</p>
                    )}
                  </div>
                  {/* Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => openEdit(zone)} disabled={creating || editingId !== null} className="p-2 rounded-sm hover:bg-smoke-100 text-[var(--color-text-secondary)] hover:text-charcoal-700 disabled:opacity-30 transition-colors" title="Editar">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => handleDelete(zone.id)} disabled={creating || editingId !== null} className="p-2 rounded-sm hover:bg-accent-red/10 text-[var(--color-text-secondary)] hover:text-accent-red disabled:opacity-30 transition-colors" title="Excluir">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PageShell>
  )
}
