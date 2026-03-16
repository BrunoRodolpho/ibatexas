'use client'

import { useState, useEffect } from 'react'
import { MapPin, Plus, Trash2, Pencil } from 'lucide-react'
import { getApiBase } from '@/lib/api'

function formatPrice(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
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

export default function ZonasPage() {
  const [zones, setZones] = useState<DeliveryZone[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<DeliveryZone | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<Omit<DeliveryZone, 'id'>>(emptyZone())
  const [cepInput, setCepInput] = useState('')
  const [saving, setSaving] = useState(false)

  async function loadZones() {
    try {
      const res = await fetch(`${getApiBase()}/api/admin/delivery-zones`, { credentials: 'include' })
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

  function openCreate() {
    setForm(emptyZone())
    setCepInput('')
    setEditing(null)
    setCreating(true)
  }

  function openEdit(zone: DeliveryZone) {
    setForm({ name: zone.name, cepPrefixes: zone.cepPrefixes, feeInCentavos: zone.feeInCentavos, estimatedMinutes: zone.estimatedMinutes, active: zone.active })
    setCepInput(zone.cepPrefixes.join(', '))
    setEditing(zone)
    setCreating(false)
  }

  async function handleSave() {
    setSaving(true)
    setError(null)
    const parsedCeps = cepInput.split(',').map((c) => c.trim()).filter((c) => /^\d{5}$/.test(c))
    const payload = { ...form, cepPrefixes: parsedCeps }
    try {
      const url = editing
        ? `${getApiBase()}/api/admin/delivery-zones/${editing.id}`
        : `${getApiBase()}/api/admin/delivery-zones`
      const res = await fetch(url, {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('Erro ao salvar zona')
      setEditing(null)
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
      await fetch(`${getApiBase()}/api/admin/delivery-zones/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      await loadZones()
    } catch {
      setError('Erro ao excluir zona')
    }
  }

  const showForm = creating || editing !== null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <MapPin className="h-6 w-6 text-brand-600" />
          <h1 className="text-2xl font-display text-charcoal-900">Zonas de Entrega</h1>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Nova zona
        </button>
      </div>

      {error && <p className="text-sm text-accent-red">{error}</p>}

      {showForm && (
        <div className="rounded-sm border border-brand-200 bg-brand-50 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-charcoal-900">{editing ? 'Editar zona' : 'Nova zona'}</h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label htmlFor="zone-name" className="block text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-1">Nome</label>
              <input
                id="zone-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ex: Zona Sul"
                className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div className="col-span-2">
              <label htmlFor="zone-cep" className="block text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-1">
                Prefixos CEP (5 dígitos, separados por vírgula)
              </label>
              <input
                id="zone-cep"
                value={cepInput}
                onChange={(e) => setCepInput(e.target.value)}
                placeholder="01310, 01311, 01320"
                className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="zone-fee" className="block text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-1">Taxa (R$)</label>
              <input
                id="zone-fee"
                type="number"
                step="0.01"
                value={form.feeInCentavos / 100}
                onChange={(e) => setForm((f) => ({ ...f, feeInCentavos: Math.round(Number.parseFloat(e.target.value || '0') * 100) }))}
                className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="zone-time" className="block text-xs font-semibold uppercase tracking-editorial text-smoke-400 mb-1">Prazo (min)</label>
              <input
                id="zone-time"
                type="number"
                value={form.estimatedMinutes}
                onChange={(e) => setForm((f) => ({ ...f, estimatedMinutes: Number.parseInt(e.target.value || '60', 10) }))}
                className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
            </div>
            <div className="col-span-2 flex items-center gap-2">
              <input
                type="checkbox"
                id="active"
                checked={form.active}
                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                className="rounded border-smoke-300"
              />
              <label htmlFor="active" className="text-sm text-charcoal-700">Ativa</label>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !form.name}
              className="rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
            <button
              onClick={() => { setCreating(false); setEditing(null) }}
              className="rounded-sm border border-smoke-200 px-4 py-2 text-sm text-smoke-400 hover:border-smoke-300"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {(() => {
        if (loading) {
          return <p className="text-sm text-smoke-400">Carregando…</p>
        }
        if (zones.length === 0) {
          return <p className="text-sm text-smoke-400">Nenhuma zona de entrega cadastrada.</p>
        }
        return (
          <div className="space-y-2">
            {zones.map((zone) => (
              <div key={zone.id} className="flex items-center justify-between rounded-sm border border-smoke-200 bg-smoke-50 p-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-charcoal-900">{zone.name}</span>
                    {!zone.active && (
                      <span className="text-xs rounded-full bg-smoke-200 px-2 py-0.5 text-smoke-400">Inativa</span>
                    )}
                  </div>
                  <p className="text-xs text-smoke-400 mt-0.5">
                    CEPs: {zone.cepPrefixes.join(', ')} · {formatPrice(zone.feeInCentavos)} · {zone.estimatedMinutes} min
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => openEdit(zone)} className="p-1.5 rounded hover:bg-smoke-200 text-smoke-400 hover:text-charcoal-700">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button onClick={() => handleDelete(zone.id)} className="p-1.5 rounded hover:bg-accent-red/10 text-smoke-400 hover:text-accent-red">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      })()}
    </div>
  )
}

