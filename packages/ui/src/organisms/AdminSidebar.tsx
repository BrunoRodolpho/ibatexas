'use client'

import type { ComponentType, ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import clsx from 'clsx'

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
  /** When true, render a narrow icon-only sidebar (tablet breakpoint) */
  collapsed?: boolean
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
  collapsed = false,
}: Readonly<AdminSidebarBaseProps>) {
  return (
    <aside
      className={clsx(
        'flex h-full shrink-0 flex-col border-r border-smoke-200 bg-smoke-50',
        collapsed ? 'w-16' : 'w-[240px]',
      )}
    >
      <div className={clsx('flex h-14 items-center', collapsed ? 'justify-center px-2' : 'px-5')}>
        <LinkComponent href="/admin" className="flex items-center gap-2">
          <span className="text-base font-semibold text-charcoal-900">
            {collapsed ? 'IX' : 'IbateXas'}
          </span>
          {!collapsed && (
            <span className="rounded-sm bg-smoke-100 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-secondary)]">
              Admin
            </span>
          )}
        </LinkComponent>
      </div>

      <nav className={clsx('flex-1 overflow-y-auto pb-3', collapsed ? 'px-1.5' : 'px-3')}>
        {groups.map((group) => (
          <div key={group.label} className="mt-5 first:mt-0">
            {!collapsed && (
              <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-secondary)]">
                {group.label}
              </p>
            )}
            <ul className="space-y-px">
              {group.items.map((item) => {
                const active = isActive(pathname, item.href)
                const Icon = item.icon
                return (
                  <li key={item.key}>
                    <LinkComponent
                      href={item.href}
                      className={clsx(
                        'flex items-center rounded-sm py-1.5 text-[13px] font-medium transition-all duration-500',
                        collapsed ? 'justify-center px-0' : 'gap-2.5 px-2',
                        active
                          ? 'bg-smoke-100 text-charcoal-900'
                          : 'text-[var(--color-text-secondary)] hover:bg-smoke-100 hover:text-charcoal-700',
                      )}
                      {...(collapsed ? { title: item.label } : {})}
                    >
                      <Icon className={clsx('h-4 w-4 shrink-0', active ? 'text-charcoal-900' : 'text-[var(--color-text-muted)]')} />
                      {!collapsed && <span>{item.label}</span>}
                    </LinkComponent>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className={clsx('border-t border-smoke-200 py-2', collapsed ? 'px-1.5' : 'px-3')}>
        <a
          href={`${medusaAdminUrl}/app`}
          target="_blank"
          rel="noopener noreferrer"
          className={clsx(
            'flex items-center rounded-sm py-1.5 text-[13px] font-medium text-[var(--color-text-secondary)] hover:bg-smoke-100 hover:text-charcoal-700 transition-all duration-500',
            collapsed ? 'justify-center px-0' : 'gap-2 px-2',
          )}
          {...(collapsed ? { title: 'Medusa Admin' } : {})}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {!collapsed && 'Medusa Admin'}
        </a>
      </div>
    </aside>
  )
}
