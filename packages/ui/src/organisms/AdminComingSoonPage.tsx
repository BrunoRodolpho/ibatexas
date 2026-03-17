'use client'

import type { ComponentType } from 'react'

export interface AdminComingSoonPageProps {
  icon: ComponentType<{ className?: string }>
  title: string
  description?: string
}

export function AdminComingSoonPage({
  icon: Icon,
  title,
  description = 'Módulo em desenvolvimento.',
}: Readonly<AdminComingSoonPageProps>) {
  return (
    <div className="flex h-full min-h-[400px] items-center justify-center">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-sm bg-smoke-100">
          <Icon className="h-8 w-8 text-smoke-300" />
        </div>
        <h2 className="text-xl font-bold text-charcoal-900">{title}</h2>
        <p className="mt-2 text-sm text-smoke-400">{description}</p>
        <span className="mt-4 inline-block rounded-full bg-brand-100 px-3 py-1 text-xs font-semibold text-brand-700">
          Em breve
        </span>
      </div>
    </div>
  )
}
