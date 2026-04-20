'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import { Clock, Plus, Trash2, Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { PageHeader } from '../atoms/PageHeader'
import { SectionHeader } from '../atoms/SectionHeader'
import { PageSkeleton } from '../atoms/PageSkeleton'
import { EmptyState } from '../atoms/EmptyState'
import { ErrorBanner } from '../atoms/ErrorBanner'
import { PageShell } from '../layouts/PageShell'
import { FilterChip } from '../molecules/FilterChip'
import { FilterBar } from '../molecules/FilterBar'
import { Modal } from '../molecules/Modal'
import { PAGE_TITLES, EMPTY_STATES } from '../constants/admin-labels'

// ── Constants ────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'] as const
const DAY_NAMES_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'] as const
const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'] as const

// ── Types ────────────────────────────────────────────────────────────────────

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
  allDay: boolean
  startTime: string | null
  endTime: string | null
}

interface TimeBlock {
  label: string
  start: string
  end: string
}

interface ScheduleOverrideEntry {
  id: string
  date: string
  isOpen: boolean
  blocks: TimeBlock[]
  note: string | null
}

export interface AdminHorariosPageProps {
  apiBase: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const defaultDay = (dayOfWeek: number): DaySchedule => ({
  dayOfWeek,
  isOpen: true,
  lunchStart: '11:00',
  lunchEnd: '15:00',
  dinnerStart: '18:00',
  dinnerEnd: '23:00',
})

function pad2(n: number): string { return String(n).padStart(2, '0') }

function toDateStr(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`
}

function getCalendarDays(year: number, month: number): Array<{ date: string; day: number; inMonth: boolean }> {
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const daysInPrev = new Date(year, month, 0).getDate()
  const cells: Array<{ date: string; day: number; inMonth: boolean }> = []

  // Previous month fill
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = daysInPrev - i
    const pm = month === 0 ? 11 : month - 1
    const py = month === 0 ? year - 1 : year
    cells.push({ date: toDateStr(py, pm, d), day: d, inMonth: false })
  }
  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: toDateStr(year, month, d), day: d, inMonth: true })
  }
  // Next month fill
  const remaining = 42 - cells.length
  for (let d = 1; d <= remaining; d++) {
    const nm = month === 11 ? 0 : month + 1
    const ny = month === 11 ? year + 1 : year
    cells.push({ date: toDateStr(ny, nm, d), day: d, inMonth: false })
  }
  return cells
}

function formatDateLong(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
}

function dayTemplateBlocks(day: DaySchedule): TimeBlock[] {
  const blocks: TimeBlock[] = []
  if (day.lunchStart && day.lunchEnd) blocks.push({ label: 'Almoço', start: day.lunchStart, end: day.lunchEnd })
  if (day.dinnerStart && day.dinnerEnd) blocks.push({ label: 'Jantar', start: day.dinnerStart, end: day.dinnerEnd })
  return blocks
}

// ── Day Edit Modal ───────────────────────────────────────────────────────────

type DayMode = 'default' | 'custom' | 'closed'

function DayEditModal({
  dateStr,
  templateBlocks,
  templateIsOpen,
  existingOverride,
  holiday,
  onSave,
  onDelete,
  onClose,
}: {
  dateStr: string
  templateBlocks: TimeBlock[]
  templateIsOpen: boolean
  existingOverride: ScheduleOverrideEntry | null
  holiday: HolidayEntry | null
  onSave: (date: string, data: { isOpen: boolean; blocks: TimeBlock[]; note?: string | null }) => Promise<void>
  onDelete: (date: string) => Promise<void>
  onClose: () => void
}) {
  const initialMode: DayMode = existingOverride
    ? (existingOverride.isOpen ? 'custom' : 'closed')
    : 'default'

  const [mode, setMode] = useState<DayMode>(initialMode)
  const [blocks, setBlocks] = useState<TimeBlock[]>(
    existingOverride?.isOpen ? existingOverride.blocks : templateBlocks
  )
  const [note, setNote] = useState(existingOverride?.note ?? '')
  const [saving, setSaving] = useState(false)

  function addBlock() {
    setBlocks((prev) => [...prev, { label: '', start: '11:00', end: '15:00' }])
  }

  function updateBlock(idx: number, patch: Partial<TimeBlock>) {
    setBlocks((prev) => prev.map((b, i) => i === idx ? { ...b, ...patch } : b))
  }

  function removeBlock(idx: number) {
    setBlocks((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleSave() {
    setSaving(true)
    try {
      if (mode === 'default') {
        await onDelete(dateStr)
      } else {
        await onSave(dateStr, {
          isOpen: mode === 'custom',
          blocks: mode === 'custom' ? blocks : [],
          note: note || null,
        })
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const templateDesc = templateIsOpen
    ? templateBlocks.map((b) => `${b.label} ${b.start}–${b.end}`).join(', ')
    : 'Fechado'

  return (
    <Modal isOpen title={formatDateLong(dateStr)} onClose={onClose} size="md" footer={
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="rounded-sm border border-smoke-200 px-4 py-2 text-sm text-charcoal-700 hover:bg-smoke-100">
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {saving ? 'Salvando...' : 'Salvar'}
        </button>
      </div>
    }>
      {holiday && (
        <div className="mb-4 rounded-sm border border-accent-red/20 bg-accent-red/5 p-3 text-sm text-accent-red">
          Feriado: <strong>{holiday.label}</strong>
          {holiday.allDay ? ' (dia inteiro)' : ` ${holiday.startTime}–${holiday.endTime}`}
        </div>
      )}

      <div className="space-y-4">
        {/* Default */}
        <label className="flex items-start gap-3 cursor-pointer rounded-sm border border-smoke-200 p-3 hover:bg-smoke-50">
          <input type="radio" name="mode" checked={mode === 'default'} onChange={() => setMode('default')} className="mt-0.5" />
          <div>
            <p className="text-sm font-medium text-charcoal-900">Usar horário padrão</p>
            <p className="text-xs text-[var(--color-text-secondary)]">{templateDesc}</p>
          </div>
        </label>

        {/* Custom */}
        <label className="flex items-start gap-3 cursor-pointer rounded-sm border border-smoke-200 p-3 hover:bg-smoke-50">
          <input type="radio" name="mode" checked={mode === 'custom'} onChange={() => setMode('custom')} className="mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium text-charcoal-900">Horário especial</p>
          </div>
        </label>

        {mode === 'custom' && (
          <div className="ml-7 space-y-2">
            {blocks.map((block, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <input
                  value={block.label}
                  onChange={(e) => updateBlock(idx, { label: e.target.value })}
                  placeholder="Período"
                  className="w-24 rounded-sm border border-smoke-200 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none"
                />
                <input
                  type="time"
                  value={block.start}
                  onChange={(e) => updateBlock(idx, { start: e.target.value })}
                  className="rounded-sm border border-smoke-200 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none"
                />
                <span className="text-[var(--color-text-secondary)]">–</span>
                <input
                  type="time"
                  value={block.end}
                  onChange={(e) => updateBlock(idx, { end: e.target.value })}
                  className="rounded-sm border border-smoke-200 px-2 py-1 text-sm focus:border-brand-500 focus:outline-none"
                />
                <button onClick={() => removeBlock(idx)} className="p-1 text-smoke-400 hover:text-accent-red">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button onClick={addBlock} className="flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700">
              <Plus className="h-3 w-3" /> Adicionar bloco
            </button>
          </div>
        )}

        {/* Closed */}
        <label className="flex items-start gap-3 cursor-pointer rounded-sm border border-smoke-200 p-3 hover:bg-smoke-50">
          <input type="radio" name="mode" checked={mode === 'closed'} onChange={() => setMode('closed')} className="mt-0.5" />
          <p className="text-sm font-medium text-charcoal-900">Fechado neste dia</p>
        </label>

        {/* Note */}
        {mode !== 'default' && (
          <div className="ml-7">
            <label className="block text-xs font-medium text-[var(--color-text-secondary)] mb-1">Nota (opcional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ex: Evento especial, reformas..."
              className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>
        )}
      </div>
    </Modal>
  )
}

// ── Main Component ───────────────────────────────────────────────────────────

export function AdminHorariosPage({ apiBase }: Readonly<AdminHorariosPageProps>) {
  // Weekly template state
  const [days, setDays] = useState<DaySchedule[]>(Array.from({ length: 7 }, (_, i) => defaultDay(i)))
  const [holidays, setHolidays] = useState<HolidayEntry[]>([])
  const [overrides, setOverrides] = useState<ScheduleOverrideEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingWeekly, setSavingWeekly] = useState(false)
  const [weeklyDirty, setWeeklyDirty] = useState(false)

  // Calendar state
  const today = new Date()
  const [calYear, setCalYear] = useState(today.getFullYear())
  const [calMonth, setCalMonth] = useState(today.getMonth())
  const [editingDate, setEditingDate] = useState<string | null>(null)

  // Holiday form
  const [addingHoliday, setAddingHoliday] = useState(false)
  const [holidayDate, setHolidayDate] = useState('')
  const [holidayLabel, setHolidayLabel] = useState('')
  const [holidayAllDay, setHolidayAllDay] = useState(true)
  const [holidayStartTime, setHolidayStartTime] = useState('')
  const [holidayEndTime, setHolidayEndTime] = useState('')
  const [savingHoliday, setSavingHoliday] = useState(false)

  // Exception form (quick-add from list, not calendar)
  const [addingException, setAddingException] = useState(false)
  const [exceptionDate, setExceptionDate] = useState('')

  // Combined filters for holidays + exceptions list
  const [listSearch, setListSearch] = useState('')
  const [listTypeFilter, setListTypeFilter] = useState<'' | 'holiday' | 'exception'>('')
  const [listDateFilter, setListDateFilter] = useState('')

  // Template section collapsed state
  const [templateExpanded, setTemplateExpanded] = useState(false)

  // ── Data loading ───────────────────────────────────────────────────

  const loadSchedule = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/admin/schedule`, { credentials: 'include' })
      if (!res.ok) throw new Error('Erro ao carregar horários')
      const data = await res.json() as { days: DaySchedule[]; holidays: HolidayEntry[]; overrides?: ScheduleOverrideEntry[] }
      const loaded = Array.from({ length: 7 }, (_, i) =>
        data.days.find((d) => d.dayOfWeek === i) ?? defaultDay(i)
      )
      setDays(loaded)
      setHolidays(data.holidays ?? [])
      setOverrides(data.overrides ?? [])
      setWeeklyDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar horários')
    } finally {
      setLoading(false)
    }
  }, [apiBase])

  useEffect(() => { void loadSchedule() }, [loadSchedule])

  // ── Weekly template handlers ───────────────────────────────────────

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
      if (!res.ok) {
        let detail = 'Erro ao salvar horários'
        try { const b = await res.json() as Record<string, string>; detail = b.message ?? b.error ?? detail } catch { /* */ }
        throw new Error(detail)
      }
      setWeeklyDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar')
    } finally {
      setSavingWeekly(false)
    }
  }

  // ── Holiday handlers ───────────────────────────────────────────────

  async function handleAddHoliday() {
    if (!holidayDate || !holidayLabel) return
    setSavingHoliday(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { date: holidayDate, label: holidayLabel, allDay: holidayAllDay }
      if (!holidayAllDay) { body.startTime = holidayStartTime || null; body.endTime = holidayEndTime || null }
      const res = await fetch(`${apiBase}/api/admin/schedule/holidays`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
      })
      if (!res.ok) {
        let detail = 'Erro ao adicionar feriado'
        try { const b = await res.json() as Record<string, string>; detail = b.message ?? b.error ?? detail } catch { /* */ }
        throw new Error(detail)
      }
      setAddingHoliday(false); setHolidayDate(''); setHolidayLabel(''); setHolidayAllDay(true); setHolidayStartTime(''); setHolidayEndTime('')
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
      await fetch(`${apiBase}/api/admin/schedule/holidays/${id}`, { method: 'DELETE', credentials: 'include' })
      await loadSchedule()
    } catch { setError('Erro ao excluir feriado') }
  }

  // ── Override handlers ──────────────────────────────────────────────

  async function handleSaveOverride(date: string, data: { isOpen: boolean; blocks: TimeBlock[]; note?: string | null }) {
    const res = await fetch(`${apiBase}/api/admin/schedule/overrides/${encodeURIComponent(date)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(data),
    })
    if (!res.ok) {
      let detail = `Erro ao salvar exceção (${res.status})`
      try { const b = await res.json() as Record<string, string>; detail = b.message ?? b.error ?? detail } catch { /* */ }
      throw new Error(detail)
    }
    await loadSchedule()
  }

  async function handleDeleteOverride(date: string) {
    await fetch(`${apiBase}/api/admin/schedule/overrides/${encodeURIComponent(date)}`, { method: 'DELETE', credentials: 'include' })
    await loadSchedule()
  }

  // ── Lookups ────────────────────────────────────────────────────────

  const overrideMap = useMemo(() => new Map(overrides.map((o) => [o.date, o])), [overrides])
  const holidayMap = useMemo(() => new Map(holidays.map((h) => [h.date, h])), [holidays])

  const calendarDays = useMemo(() => getCalendarDays(calYear, calMonth), [calYear, calMonth])

  function getTemplateForDate(dateStr: string): { day: DaySchedule; blocks: TimeBlock[] } {
    const dow = new Date(dateStr + 'T12:00:00').getDay()
    const day = days[dow] ?? defaultDay(dow)
    return { day, blocks: dayTemplateBlocks(day) }
  }

  // ── Calendar navigation ────────────────────────────────────────────

  function prevMonth() {
    if (calMonth === 0) { setCalMonth(11); setCalYear((y) => y - 1) }
    else setCalMonth((m) => m - 1)
  }
  function nextMonth() {
    if (calMonth === 11) { setCalMonth(0); setCalYear((y) => y + 1) }
    else setCalMonth((m) => m + 1)
  }
  function goToday() { setCalYear(today.getFullYear()); setCalMonth(today.getMonth()) }

  // ── Unified list: holidays + exceptions ─────────────────────────────

  type ListItem =
    | { kind: 'holiday'; id: string; date: string; label: string; detail: string }
    | { kind: 'exception'; id: string; date: string; label: string; detail: string }

  const unifiedList = useMemo(() => {
    const items: ListItem[] = []
    for (const h of holidays) {
      const detail = h.allDay ? 'Dia inteiro' : `${h.startTime} – ${h.endTime}`
      items.push({ kind: 'holiday', id: h.id, date: h.date, label: h.label, detail })
    }
    for (const o of overrides) {
      const detail = o.isOpen
        ? o.blocks.map((b) => `${b.label} ${b.start}–${b.end}`).join(', ')
        : 'Fechado'
      items.push({ kind: 'exception', id: o.id, date: o.date, label: o.note ?? 'Horário especial', detail })
    }
    items.sort((a, b) => a.date.localeCompare(b.date))
    return items
  }, [holidays, overrides])

  const filteredList = useMemo(() => {
    let list = unifiedList

    // Type filter
    if (listTypeFilter === 'holiday') list = list.filter((i) => i.kind === 'holiday')
    else if (listTypeFilter === 'exception') list = list.filter((i) => i.kind === 'exception')

    // Date filter
    if (listDateFilter) list = list.filter((i) => i.date === listDateFilter)

    // Search
    if (listSearch.trim()) {
      const q = listSearch.toLowerCase()
      list = list.filter((i) => i.label.toLowerCase().includes(q) || i.date.includes(q) || i.detail.toLowerCase().includes(q))
    }

    return list
  }, [unifiedList, listTypeFilter, listDateFilter, listSearch])

  // ── Render helpers ─────────────────────────────────────────────────

  function formatHolidayDate(dateStr: string): string {
    const [y, m, d] = dateStr.split('-')
    return `${d}/${m}/${y}`
  }

  const todayStr = toDateStr(today.getFullYear(), today.getMonth(), today.getDate())

  if (loading) return <PageSkeleton variant="spinner" />

  return (
    <PageShell>
      {/* Header */}
      <PageHeader icon={Clock} title={PAGE_TITLES.hours} subtitle={PAGE_TITLES.hoursSubtitle} />

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {/* ── Default Template (collapsible) ────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader
          title="Horário Padrão Semanal"
          collapsible
          expanded={templateExpanded}
          onToggle={() => setTemplateExpanded(!templateExpanded)}
        />

        {templateExpanded && (
          <div className="space-y-2 ml-6">
            {days.map((day) => (
              <div key={day.dayOfWeek} className="flex items-center gap-4 rounded-sm border border-smoke-200 bg-smoke-50 p-3">
                <div className="w-24 flex items-center gap-2">
                  <input type="checkbox" checked={day.isOpen} onChange={(e) => updateDay(day.dayOfWeek, { isOpen: e.target.checked })} className="rounded border-smoke-300" />
                  <span className="text-sm font-medium text-charcoal-900">{DAY_NAMES[day.dayOfWeek]}</span>
                </div>
                {day.isOpen ? (
                  <div className="flex flex-1 items-center gap-3 text-sm">
                    <span className="text-xs text-[var(--color-text-secondary)]">Almoço</span>
                    <input type="time" value={day.lunchStart ?? ''} onChange={(e) => updateDay(day.dayOfWeek, { lunchStart: e.target.value || null })} className="rounded-sm border border-smoke-200 px-2 py-1 text-sm" />
                    <span className="text-[var(--color-text-secondary)]">–</span>
                    <input type="time" value={day.lunchEnd ?? ''} onChange={(e) => updateDay(day.dayOfWeek, { lunchEnd: e.target.value || null })} className="rounded-sm border border-smoke-200 px-2 py-1 text-sm" />
                    <span className="mx-2 text-smoke-300">|</span>
                    <span className="text-xs text-[var(--color-text-secondary)]">Jantar</span>
                    <input type="time" value={day.dinnerStart ?? ''} onChange={(e) => updateDay(day.dayOfWeek, { dinnerStart: e.target.value || null })} className="rounded-sm border border-smoke-200 px-2 py-1 text-sm" />
                    <span className="text-[var(--color-text-secondary)]">–</span>
                    <input type="time" value={day.dinnerEnd ?? ''} onChange={(e) => updateDay(day.dayOfWeek, { dinnerEnd: e.target.value || null })} className="rounded-sm border border-smoke-200 px-2 py-1 text-sm" />
                  </div>
                ) : (
                  <span className="text-sm text-[var(--color-text-secondary)] italic">Fechado</span>
                )}
              </div>
            ))}
            <button onClick={handleSaveWeekly} disabled={savingWeekly || !weeklyDirty}
              className="rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
              {savingWeekly ? 'Salvando...' : 'Salvar horários'}
            </button>
          </div>
        )}
      </div>

      {/* ── Calendar ──────────────────────────────────────────────── */}
      <div className="max-w-3xl space-y-4">
        <SectionHeader title="Calendário" />

        {/* Navigation */}
        <div className="flex items-center gap-4">
          <button onClick={prevMonth} className="p-1.5 rounded-sm hover:bg-smoke-100 text-charcoal-700">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h3 className="text-base font-semibold text-charcoal-900 min-w-[180px] text-center">
            {MONTH_NAMES[calMonth]} {calYear}
          </h3>
          <button onClick={nextMonth} className="p-1.5 rounded-sm hover:bg-smoke-100 text-charcoal-700">
            <ChevronRight className="h-5 w-5" />
          </button>
          <button onClick={goToday} className="rounded-sm border border-smoke-200 px-3 py-1 text-xs font-medium text-charcoal-700 hover:bg-smoke-100">
            Hoje
          </button>
        </div>

        {/* Grid */}
        <div className="border border-smoke-200 rounded-sm overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-7 bg-smoke-100 border-b border-smoke-200">
            {DAY_NAMES_SHORT.map((name) => (
              <div key={name} className="py-2 text-center text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                {name}
              </div>
            ))}
          </div>
          {/* Cells */}
          <div className="grid grid-cols-7">
            {calendarDays.map((cell) => {
              const isToday = cell.date === todayStr
              const override = overrideMap.get(cell.date)
              const holiday = holidayMap.get(cell.date)
              const { day: templateDay } = getTemplateForDate(cell.date)
              const isClosed = holiday?.allDay || override?.isOpen === false || (!override && !templateDay.isOpen)

              return (
                <button
                  key={cell.date}
                  onClick={() => setEditingDate(cell.date)}
                  className={`relative min-h-[52px] border-b border-r border-smoke-200 p-1.5 text-left transition-colors hover:bg-brand-50
                    ${!cell.inMonth ? 'bg-smoke-50 text-smoke-300' : 'bg-white text-charcoal-700'}
                    ${isToday ? 'ring-2 ring-inset ring-brand-500' : ''}
                    ${isClosed && cell.inMonth ? 'bg-accent-red/5' : ''}
                  `}
                >
                  <span className={`text-xs font-medium ${isToday ? 'text-brand-600' : ''}`}>
                    {cell.day}
                  </span>

                  {/* Indicators */}
                  <div className="absolute bottom-1.5 left-2 flex gap-1">
                    {holiday && (
                      <span className="w-2 h-2 rounded-full bg-accent-red" title={holiday.label} />
                    )}
                    {override && (
                      <span className="w-2 h-2 rounded-full bg-brand-500" title={override.note ?? 'Exceção'} />
                    )}
                  </div>

                  {/* Closed label */}
                  {isClosed && cell.inMonth && (
                    <span className="block text-[10px] text-accent-red/60 mt-0.5">Fechado</span>
                  )}

                  {/* Override note preview */}
                  {override && override.isOpen && cell.inMonth && (
                    <span className="block text-[10px] text-brand-600 mt-0.5 truncate max-w-full">
                      {override.note ?? override.blocks.map((b) => b.label).join(', ')}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-xs text-[var(--color-text-secondary)]">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-accent-red" /> Feriado</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-brand-500" /> Exceção</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm ring-2 ring-brand-500" /> Hoje</span>
        </div>
      </div>

      {/* ── Day Edit Modal ────────────────────────────────────────── */}
      {editingDate && (() => {
        const { day, blocks } = getTemplateForDate(editingDate)
        return (
          <DayEditModal
            dateStr={editingDate}
            templateBlocks={blocks}
            templateIsOpen={day.isOpen}
            existingOverride={overrideMap.get(editingDate) ?? null}
            holiday={holidayMap.get(editingDate) ?? null}
            onSave={handleSaveOverride}
            onDelete={handleDeleteOverride}
            onClose={() => setEditingDate(null)}
          />
        )
      })()}

      {/* ── Feriados & Exceções ─────────────────────────────────── */}
      <div className="space-y-4">
        <SectionHeader
          title="Feriados e Exceções"
          action={
            <div className="flex gap-2">
              <button onClick={() => setAddingHoliday(true)} className="flex items-center gap-2 rounded-sm bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700">
                <Plus className="h-3.5 w-3.5" /> Novo feriado
              </button>
              <button
                onClick={() => { setAddingException(true); setExceptionDate('') }}
                className="flex items-center gap-2 rounded-sm border border-brand-600 px-3 py-1.5 text-sm font-semibold text-brand-600 hover:bg-brand-50"
              >
                <Plus className="h-3.5 w-3.5" /> Nova exceção
              </button>
            </div>
          }
        />

        {/* Filters: type chips + date picker + search */}
        <FilterBar>
          <FilterChip id="list-all" label="Todos" selected={listTypeFilter === ''} onToggle={() => setListTypeFilter('')} />
          <FilterChip id="list-holidays" label="Feriados" selected={listTypeFilter === 'holiday'} onToggle={() => setListTypeFilter(listTypeFilter === 'holiday' ? '' : 'holiday')} />
          <FilterChip id="list-exceptions" label="Exceções" selected={listTypeFilter === 'exception'} onToggle={() => setListTypeFilter(listTypeFilter === 'exception' ? '' : 'exception')} />
          <input
            type="date"
            value={listDateFilter}
            onChange={(e) => setListDateFilter(e.target.value)}
            className="rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1.5 text-sm text-charcoal-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-smoke-400" />
            <input type="text" value={listSearch} onChange={(e) => setListSearch(e.target.value)} placeholder="Buscar..."
              className="rounded-sm border border-smoke-200 bg-smoke-50 pl-8 pr-3 py-1.5 text-sm text-charcoal-700 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500" />
          </div>
          {(listTypeFilter || listDateFilter || listSearch) && (
            <button onClick={() => { setListTypeFilter(''); setListDateFilter(''); setListSearch('') }}
              className="flex items-center gap-1 text-xs text-[var(--color-text-secondary)] hover:text-charcoal-700">
              <ChevronRight className="h-3 w-3 rotate-45" /> Limpar
            </button>
          )}
        </FilterBar>

        {/* Add holiday form */}
        {addingHoliday && (
          <div className="rounded-sm border border-brand-200 bg-brand-50 p-4 space-y-3">
            <p className="text-sm font-semibold text-charcoal-900">Novo feriado</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-1">Data</label>
                <input type="date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-1">Descrição</label>
                <input value={holidayLabel} onChange={(e) => setHolidayLabel(e.target.value)} placeholder="Ex: Natal" className="w-full rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
              </div>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-charcoal-700">
                <input type="checkbox" checked={holidayAllDay} onChange={(e) => setHolidayAllDay(e.target.checked)} className="rounded border-smoke-300" /> Dia inteiro
              </label>
              {!holidayAllDay && (
                <div className="flex items-center gap-2">
                  <input type="time" value={holidayStartTime} onChange={(e) => setHolidayStartTime(e.target.value)} className="rounded-sm border border-smoke-200 px-2 py-1 text-sm" />
                  <span className="text-[var(--color-text-secondary)]">–</span>
                  <input type="time" value={holidayEndTime} onChange={(e) => setHolidayEndTime(e.target.value)} className="rounded-sm border border-smoke-200 px-2 py-1 text-sm" />
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={handleAddHoliday} disabled={savingHoliday || !holidayDate || !holidayLabel} className="rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
                {savingHoliday ? 'Salvando...' : 'Adicionar'}
              </button>
              <button onClick={() => { setAddingHoliday(false); setHolidayDate(''); setHolidayLabel(''); setHolidayAllDay(true) }} className="rounded-sm border border-smoke-200 px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:border-smoke-300">
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Add exception form (quick-add — opens modal for the chosen date) */}
        {addingException && (
          <div className="rounded-sm border border-brand-200 bg-brand-50 p-4 space-y-3">
            <p className="text-sm font-semibold text-charcoal-900">Nova exceção de horário</p>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-editorial text-[var(--color-text-secondary)] mb-1">Data</label>
              <input type="date" value={exceptionDate} onChange={(e) => setExceptionDate(e.target.value)} className="w-64 rounded-sm border border-smoke-200 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none" />
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => { if (exceptionDate) { setEditingDate(exceptionDate); setAddingException(false) } }}
                disabled={!exceptionDate}
                className="rounded-sm bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
              >
                Configurar horário
              </button>
              <button onClick={() => setAddingException(false)} className="rounded-sm border border-smoke-200 px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:border-smoke-300">
                Cancelar
              </button>
            </div>
          </div>
        )}

        {/* Unified list */}
        {filteredList.length === 0 && (
          <EmptyState
            icon={Clock}
            title={unifiedList.length === 0 ? EMPTY_STATES.hours : EMPTY_STATES.hoursFiltered}
          />
        )}
        <div className="space-y-2">
          {filteredList.map((item) => (
            <div key={`${item.kind}-${item.id}`} className="flex items-center justify-between rounded-sm border border-smoke-200 bg-smoke-50 p-3">
              <div className="flex items-center gap-3">
                {/* Type badge */}
                {item.kind === 'holiday' ? (
                  <span className="w-2 h-2 rounded-full bg-accent-red shrink-0" />
                ) : (
                  <span className="w-2 h-2 rounded-full bg-brand-500 shrink-0" />
                )}
                <span className="font-medium text-charcoal-900">{item.label}</span>
                <span className="text-sm text-[var(--color-text-secondary)]">{formatHolidayDate(item.date)}</span>
                <span className={`text-xs rounded-sm px-2 py-0.5 ${
                  item.kind === 'holiday'
                    ? 'text-accent-red bg-accent-red/5 border border-accent-red/20'
                    : 'text-brand-600 bg-brand-50 border border-brand-200'
                }`}>
                  {item.kind === 'holiday' ? 'Feriado' : 'Exceção'}
                </span>
                <span className="text-xs text-[var(--color-text-secondary)]">{item.detail}</span>
              </div>
              <div className="flex items-center gap-1">
                {item.kind === 'exception' && (
                  <button onClick={() => setEditingDate(item.date)} className="p-1.5 rounded-sm hover:bg-smoke-100 text-[var(--color-text-secondary)] hover:text-charcoal-700" title="Editar">
                    <Clock className="h-4 w-4" />
                  </button>
                )}
                <button
                  onClick={() => item.kind === 'holiday' ? handleDeleteHoliday(item.id) : handleDeleteOverride(item.date)}
                  className="p-1.5 rounded-sm hover:bg-accent-red/10 text-[var(--color-text-secondary)] hover:text-accent-red"
                  title="Excluir"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </PageShell>
  )
}
