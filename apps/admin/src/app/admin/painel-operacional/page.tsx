'use client'

// Painel Operacional — a READ-ONLY manager ops-overview (NEW-041). Renders the
// composed GET /api/admin/ops/snapshot view (NEW-040 / PR #158) as a small grid
// of cards: alertas abertos (per-severity), incidentes abertos, carga da cozinha
// (tickets ativos + espera mais antiga + profundidade da fila) e caixa de hoje
// (valores em centavos inteiros). NO mutation — the only action is Atualizar
// (reload). All non-trivial logic (money/duration/label formatting) lives in the
// PURE ops-snapshot.mappers module. pt-BR throughout (Hard Rule #4).

import { useEffect } from 'react'
import { Gauge, RefreshCw } from 'lucide-react'
import { Badge, useToast } from '@ibatexas/ui'
import { useAdminOpsSnapshot } from '@/domains/admin/admin.hooks'
import {
  formatCentavosBRL,
  formatDurationMs,
  queueStatusLabel,
  severityLabel,
  severityBadgeVariant,
  type OpsAlertSeverity,
  type OpsSnapshot,
} from '@/domains/admin/ops-snapshot.mappers'

const LOAD_FAILED_TOAST = 'Falha ao carregar o panorama operacional.'

// Severity bands shown high→low (worst first) in the alertas card.
const SEVERITY_ORDER: readonly OpsAlertSeverity[] = ['high', 'medium', 'low']

// ── Card shell (matches the app's border-smoke card language) ────────────────

function OpsCard({
  title,
  children,
}: Readonly<{ title: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 rounded-sm border border-smoke-200 bg-smoke-50 p-4">
      <h2 className="text-[10px] font-medium uppercase tracking-wider text-smoke-400">
        {title}
      </h2>
      {children}
    </div>
  )
}

/** Big headline count (tabular so digits don't jitter on refresh). */
function BigCount({ value }: Readonly<{ value: number }>): React.JSX.Element {
  return <span className="text-3xl font-semibold tabular-nums text-charcoal-900">{value}</span>
}

/** A "label … value" row used inside the cozinha / caixa cards. */
function StatRow({
  label,
  value,
  strong,
}: Readonly<{ label: string; value: string; strong?: boolean }>): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-smoke-500">{label}</span>
      <span
        className={`tabular-nums ${strong ? 'font-semibold text-charcoal-900' : 'text-charcoal-700'}`}
      >
        {value}
      </span>
    </div>
  )
}

// ── Cards ────────────────────────────────────────────────────────────────────

function AlertasCard({ opsAlerts }: Readonly<Pick<OpsSnapshot, 'opsAlerts'>>): React.JSX.Element {
  return (
    <OpsCard title="Alertas abertos">
      <BigCount value={opsAlerts.open} />
      <div className="flex flex-wrap gap-1.5">
        {SEVERITY_ORDER.map((band) => (
          <Badge key={band} variant={severityBadgeVariant(band)} className="tabular-nums">
            {severityLabel(band)}: {opsAlerts.bySeverity[band]}
          </Badge>
        ))}
      </div>
    </OpsCard>
  )
}

function IncidentesCard({ incidents }: Readonly<Pick<OpsSnapshot, 'incidents'>>): React.JSX.Element {
  return (
    <OpsCard title="Incidentes abertos">
      <BigCount value={incidents.open} />
      <p className="text-sm text-smoke-500">Conversas sem resposta em aberto.</p>
    </OpsCard>
  )
}

function CozinhaCard({ kitchen }: Readonly<Pick<OpsSnapshot, 'kitchen'>>): React.JSX.Element {
  return (
    <OpsCard title="Cozinha">
      <div className="flex items-baseline gap-2">
        <BigCount value={kitchen.activeTickets} />
        <span className="text-sm text-smoke-500">tickets ativos</span>
      </div>
      <StatRow label="Espera mais antiga" value={formatDurationMs(kitchen.oldestTicketAgeMs)} />
      <div className="flex flex-col gap-1 border-t border-smoke-100 pt-2">
        {kitchen.queueDepth.map((q) => (
          <StatRow key={q.status} label={queueStatusLabel(q.status)} value={String(q.count)} />
        ))}
      </div>
    </OpsCard>
  )
}

function CaixaCard({ caixa }: Readonly<Pick<OpsSnapshot, 'caixa'>>): React.JSX.Element {
  return (
    <OpsCard title="Caixa hoje">
      <div className="flex items-baseline gap-2">
        <BigCount value={caixa.ordersCount} />
        <span className="text-sm text-smoke-500">pedidos</span>
      </div>
      <div className="flex flex-col gap-1 border-t border-smoke-100 pt-2">
        <StatRow label="Bruto" value={formatCentavosBRL(caixa.grossCentavos)} />
        <StatRow label="Liquidado" value={formatCentavosBRL(caixa.settledCentavos)} />
        <StatRow label="Reembolsado" value={formatCentavosBRL(caixa.refundedCentavos)} />
        <StatRow label="Líquido" value={formatCentavosBRL(caixa.netCentavos)} strong />
      </div>
    </OpsCard>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PainelOperacionalPage(): React.JSX.Element {
  const { addToast } = useToast()
  const { snapshot, loading, error, reload } = useAdminOpsSnapshot()

  // Surface (never swallow) load failures.
  useEffect(() => {
    if (error) {
      addToast({ type: 'error', message: LOAD_FAILED_TOAST, dedupeKey: 'ops-snapshot-load' })
    }
  }, [error, addToast])

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Gauge className="mt-0.5 h-5 w-5 text-charcoal-700" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold text-charcoal-900">Painel Operacional</h1>
            <p className="text-sm text-smoke-500">
              Panorama de alertas, incidentes, cozinha e caixa — atualizado a cada 30s.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={reload}
          className="flex items-center gap-1.5 rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-1.5 text-xs font-medium text-charcoal-700 hover:bg-smoke-100"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Atualizar
        </button>
      </div>

      {/* ── Body: loading / error-empty / cards ─────────────────────────────── */}
      {loading && !snapshot ? (
        <div className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-smoke-400">
          Carregando…
        </div>
      ) : !snapshot ? (
        <div className="rounded-sm border border-smoke-200 bg-smoke-50 px-4 py-12 text-center text-smoke-400">
          Não foi possível carregar o panorama operacional. Tente atualizar.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <AlertasCard opsAlerts={snapshot.opsAlerts} />
          <IncidentesCard incidents={snapshot.incidents} />
          <CozinhaCard kitchen={snapshot.kitchen} />
          <CaixaCard caixa={snapshot.caixa} />
        </div>
      )}
    </div>
  )
}
