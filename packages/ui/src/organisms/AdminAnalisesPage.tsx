'use client'

import { ShoppingCart, DollarSign, TrendingUp, ShoppingBag, UserPlus, MessageCircle, Percent, MessageSquare } from 'lucide-react'
import { StatCard } from '../atoms/StatCard'

function formatBRL(centavos: number) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export interface AdminAnalyticsMetrics {
  ordersToday: number
  revenueToday: number
  aov: number
  activeCarts: number
  newCustomers30d: number
  outreachWeekly: number
  waConversionRate: number
  avgMessagesToCheckout: number
}

export interface AdminAnalisesPageProps {
  metrics: AdminAnalyticsMetrics | null
  loading: boolean
}

export function AdminAnalisesPage({
  metrics,
  loading,
}: Readonly<AdminAnalisesPageProps>) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal-900">Análises</h1>
        <p className="mt-1 text-sm text-smoke-400">Métricas do dia</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-8">
        <StatCard
          label="Pedidos Hoje"
          value={metrics?.ordersToday ?? 0}
          icon={ShoppingCart}
          variant="info"
          isLoading={loading}
        />
        <StatCard
          label="Receita Hoje"
          value={metrics ? formatBRL(metrics.revenueToday) : 'R$ 0,00'}
          icon={DollarSign}
          variant="success"
          isLoading={loading}
        />
        <StatCard
          label="Ticket Médio"
          value={metrics ? formatBRL(metrics.aov) : 'R$ 0,00'}
          icon={TrendingUp}
          variant="warning"
          isLoading={loading}
        />
        <StatCard
          label="Carrinhos Ativos"
          value={metrics?.activeCarts ?? 0}
          icon={ShoppingBag}
          variant="default"
          isLoading={loading}
        />
        <StatCard
          label="Novos Clientes (30d)"
          value={metrics?.newCustomers30d ?? 0}
          icon={UserPlus}
          variant="success"
          isLoading={loading}
        />
        <StatCard
          label="Outreach Semanal"
          value={metrics?.outreachWeekly ?? 0}
          icon={MessageCircle}
          variant="info"
          isLoading={loading}
        />
        <StatCard
          label="Conversao WA"
          value={`${metrics?.waConversionRate ?? 0}%`}
          icon={Percent}
          variant="success"
          isLoading={loading}
        />
        <StatCard
          label="Msgs/Pedido"
          value={metrics?.avgMessagesToCheckout ?? 0}
          icon={MessageSquare}
          variant="info"
          isLoading={loading}
        />
      </div>
    </div>
  )
}
