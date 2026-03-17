'use client'

import type { ComponentType, ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'

export interface AdminSidebarNavItem {
  key: string
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
}

export interface AdminSidebarNavGroup {
  label: string
  items: AdminSidebarNavItem[]
}

export interface AdminSidebarBaseProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LinkComponent: ComponentType<{ href: any; children: ReactNode; className?: string }>
  groups: AdminSidebarNavGroup[]
  pathname: string
  medusaAdminUrl: string
}

function isActive(pathname: string, href: string): boolean {
  if (href === '/admin') return pathname === '/admin'
  return pathname.startsWith(href)
}

export function AdminSidebarBase({
  LinkComponent,
  groups,
  pathname,
  medusaAdminUrl,
}: AdminSidebarBaseProps) {
  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-smoke-200 bg-smoke-50">
      <div className="flex h-14 items-center px-5">
        <LinkComponent href="/admin" className="flex items-center gap-2">
          <span className="text-base font-semibold text-charcoal-900">IbateXas</span>
          <span className="rounded-sm bg-smoke-100 px-1.5 py-0.5 text-[10px] font-medium text-smoke-400">
            Admin
          </span>
        </LinkComponent>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-3">
        {groups.map((group) => (
          <div key={group.label} className="mt-5 first:mt-0">
            <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-smoke-400">
              {group.label}
            </p>
            <ul className="space-y-px">
              {group.items.map((item) => {
                const active = isActive(pathname, item.href)
                const Icon = item.icon
                return (
                  <li key={item.key}>
                    <LinkComponent
                      href={item.href}
                      className={`flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-[13px] font-medium transition-all duration-500 ${
                        active
                          ? 'bg-smoke-100 text-charcoal-900'
                          : 'text-smoke-400 hover:bg-smoke-100 hover:text-charcoal-700'
                      }`}
                    >
                      <Icon className={`h-4 w-4 shrink-0 ${active ? 'text-charcoal-900' : 'text-smoke-300'}`} />
                      <span>{item.label}</span>
                    </LinkComponent>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-smoke-200 px-3 py-2">
        <a
          href={`${medusaAdminUrl}/app`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] font-medium text-smoke-400 hover:bg-smoke-100 hover:text-charcoal-700 transition-all duration-500"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Medusa Admin
        </a>
      </div>
    </aside>
  )
}
