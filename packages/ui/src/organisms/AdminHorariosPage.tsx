'use client'

import { useState, useEffect } from 'react'
import { Clock, Plus, Trash2 } from 'lucide-react'

const DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const

interface DaySchedule {
  dayOfWeek: number
  isOpen: boolean
  lunchStart: string | null
  lunchEnd: string | null
  dinnerStart: string | null
  dinnerEnd: string | null
}

interface HolidayEntry {
  id: string
  date: string
  label: string
}

export interface AdminHorariosPageProps {
  apiBase: string
}

const defaultDay = (dayOfWeek: number): DaySchedule => ({
  dayOfWeek,
  isOpen: true,
  lunchStart: '11:00',
  lunchEnd: '15:00',
  dinnerStart: '18:00',
  dinnerEnd: '23:00',
})

export function AdminHorariosPage({ apiBase }: Readonly<AdminHorariosPageProps>) {
  const [days, setDays] = useState<DaySchedule[]>(Array.from({ length: 7 }, (_, i) => defaultDay(i)))
  const [holidays, setHolidays] = useState<HolidayEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingWeekly, setSavingWeekly] = useState(false)
  const [weeklyDirty, setWeeklyDirty] = useState(false)

  // Holiday form
  const [addingHoliday, setAddingHoliday] = useState(false)
  const [holidayDate, setHolidayDate] = useState('')
  const [holidayLabel, setHolidayLabel] = useState('')
  const [savingHoliday, setSavingHoliday] = useState(false)

  async function loadSchedule() {
    try {
      const res = await fetch(`${apiBase}/api/admin/schedule`, { credentials: 'include' })
      if (!res.ok) throw new Error('Erro ao carregar horários')
      const data = await res.json() as { days: DaySchedule[]; holidays: HolidayEntry[] }
      // Ensure we always have 7 days
      const loaded = Array.from({ length: 7 }, (_, i) =>
        data.days.find((d) => d.dayOfWeek === i) ?? defaultDay(i)
      )
      setDays(loaded)
      setHolidays(data.holidays)
      setWeeklyDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar horários')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadSchedule() }, [])

  function updateDay(dayOfWeek: number, patch: Partial<DaySchedule>) {
    setDays((prev) => prev.map((d) => d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d))
    setWeeklyDirty(true)
  }

  async function handleSaveWeekly() {
    setSavingWeekly(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/admin/schedule/weekly`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ days }),
      })
      if (!res.ok) throw new Error('Erro ao salvar horários')
      setWeeklyDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar')
    } finally {
      setSavingWeekly(false)
    }
  }

  async function handleAddHoliday() {
    if (!holidayDate || !holidayLabel) return
    setSavingHoliday(true)
    setError(null)
    try {
      const res = await fetch(`${apiBase}/api/admin/schedule/holidays`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ date: holidayDate, label: holidayLabel }),
      })
      if (!res.ok) throw new Error('Erro ao adicionar feriado')
      setAddingHoliday(false)
      setHolidayDate('')
      setHolidayLabel('')
      await loadSchedule()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao adicionar feriado')
    } finally {
      setSavingHoliday(false)
    }
  }

  async function handleDeleteHoliday(id: string) {
    if (!confirm('Excluir este feriado?')) return
    try {
      await fetch(`${apiBase}/api/admin/schedule/holidays/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      await loadSchedule()
    } catch {
      setError('Erro ao excluir feriado')
    }
  }

  function formatHolidayDate(dateStr: string): string {
    const [y, m, d] = dateStr.split('-')
    return `${d}/${m}/${y}`
  }

  if (loading) {
    return <p className="text-sm text-[var(--color-text-secondary)]">Carregando...</p>
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Clock className="h-6 w-6 text-brand-600" />
        <h1 className="text-2xl font-display text-charcoal-900">Horários de Funcionamento</h1>
      </div>

      {error && <p className="text-sm text-accent-red">{error}</p>}

      {/* Weekly Schedule */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)]">
          Horário Semanal
        </h2>
        <div className="space-y-2">
          {days.map((day) => (
            <div key={day.dayOfWeek} className="flex items-center gap-4 rounded-sm border border-smoke-200 bg-smoke-50 p-3">
              {/* Day name + open checkbox */}
              <div className="w-24 flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`open-${day.dayOfWeek}`}
                  checked={day.isOpen}
                  onChange={(e) => updateDay(day.dayOfWeek, { isOpen: e.target.checked })}
                  className="rounded border-smoke-300"
                />
                <label htmlFor={`open-${day.dayOfWeek}`} className="text-sm font-medium text-charcoal-900">
                  {DAY_NAMES[day.dayOfWeek]}
                </label>
              </div>

              {day.isOpen ? (
                <div className="flex flex-1 items-center gap-3 text-sm">
                  {/* Lunch */}
                  <span className="text-xs text-[var(--color-text-secondary)]">Almoço</span>
                  <input
                    type="time"
                    value={day.lunchStart ?? ''}
                    onChange={(e) => updateDay(day.dayOfWeek, { lunchStart: e.target.value || null })}
                    className="rounded-sm border border-smoke-200 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none"
                  />
                  <span className="text-[var(--color-text-secondary)]">–</span>
                  <input
                    type="time"
                    value={day.lunchEnd ?? ''}
                    onChange={(e) => updateDay(day.dayOfWeek, { lunchEnd: e.target.value || null })}
                    className="rounded-sm border border-smoke-200 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none"
                  />

                  <span className="mx-2 text-smoke-300">|</span>

                  {/* Dinner */}
                  <span className="text-xs text-[var(--color-text-secondary)]">Jantar</span>
                  <input
                    type="time"
                    value={day.dinnerStart ?? ''}
                    onChange={(e) => updateDay(day.dayOfWeek, { dinnerStart: e.target.value || null })}
                    className="rounded-sm border border-smoke-200 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none"
                  />
                  <span className="text-[var(--color-text-secondary)]">–</span>
                  <input
                    type="time"
                    value={day.dinnerEnd ?? ''}
                    onChange={(e) => updateDay(day.dayOfWeek, { dinnerEnd: e.target.value || null })}
                    className="rounded-sm border border-smoke-200 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none"
                  />
                </div>
              ) : (
                <span className="text-sm text-[var(--color-text-secondary)] italic">Fechado</span>
              )}
            </div>
          ))}
        </div>

        <button
          onClick={handleSaveWeekly}
          disabled={savingWeekly || !weeklyDirty}
          className="rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
        >
          {savingWeekly ? 'Salvando...' : 'Salvar horários'}
        </button>
      </div>

      {/* Holidays */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)]">
            Feriados e Fechamentos
          </h2>
          <button
            onClick={() => setAddingHoliday(true)}
            className="flex items-center gap-2 rounded-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700 transition-colors"
          >
            <Plus className="h-3.5 w-3.5" />
            Novo feriado
          </button>
        </div>

        {addingHoliday && (
          <div className="rounded-sm border border-brand-200 bg-brand-50 p-4 space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="holiday-date" className="block text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-1">
                  Data
                </label>
                <input
                  id="holiday-date"
                  type="date"
                  value={holidayDate}
                  onChange={(e) => setHolidayDate(e.target.value)}
                  className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="holiday-label" className="block text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-1">
                  Descrição
                </label>
                <input
                  id="holiday-label"
                  value={holidayLabel}
                  onChange={(e) => setHolidayLabel(e.target.value)}
                  placeholder="Ex: Natal"
                  className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleAddHoliday}
                disabled={savingHoliday || !holidayDate || !holidayLabel}
                className="rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {savingHoliday ? 'Salvando...' : 'Adicionar'}
              </button>
              <button
                onClick={() => { setAddingHoliday(false); setHolidayDate(''); setHolidayLabel('') }}
                className="rounded-sm border border-smoke-200 px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:border-smoke-300"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {holidays.length === 0 && (
          <p className="text-sm text-[var(--color-text-secondary)]">Nenhum feriado cadastrado.</p>
        )}
        {holidays.length > 0 && (
          <div className="space-y-2">
            {holidays.map((h) => (
              <div key={h.id} className="flex items-center justify-between rounded-sm border border-smoke-200 bg-smoke-50 p-3">
                <div>
                  <span className="font-medium text-charcoal-900">{h.label}</span>
                  <span className="ml-2 text-sm text-[var(--color-text-secondary)]">{formatHolidayDate(h.date)}</span>
                </div>
                <button
                  onClick={() => handleDeleteHoliday(h.id)}
                  className="p-1.5 rounded hover:bg-accent-red/10 text-[var(--color-text-secondary)] hover:text-accent-red"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
