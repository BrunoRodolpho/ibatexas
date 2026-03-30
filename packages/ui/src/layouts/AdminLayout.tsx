'use client'

import { useState } from 'react'
import { Menu } from 'lucide-react'
import { Sheet } from '../molecules/Modal'

export interface AdminLayoutProps {
  /** The AdminSidebar instance (receives collapsed prop internally for tablet) */
  readonly sidebar: React.ReactNode
  /** Collapsed sidebar variant for tablet breakpoint */
  readonly collapsedSidebar?: React.ReactNode
  /** Optional custom header content rendered on the right side */
  readonly header?: React.ReactNode
  readonly children: React.ReactNode
}

export function AdminLayout({
  sidebar,
  collapsedSidebar,
  header,
  children,
}: AdminLayoutProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-smoke-50">
      {/* ── Desktop sidebar (>=1024px): full w-[240px] ──────────────── */}
      <div className="hidden lg:flex">
        {sidebar}
      </div>

      {/* ── Tablet sidebar (768-1023px): collapsed icon-only w-16 ──── */}
      <div className="hidden md:flex lg:hidden">
        {collapsedSidebar ?? sidebar}
      </div>

      {/* ── Mobile sheet (<768px): off-canvas overlay ───────────────── */}
      <Sheet
        isOpen={isMobileOpen}
        onClose={() => setIsMobileOpen(false)}
        title="Menu"
        position="left"
        closeButton
      >
        <div className="-mx-4 -mt-4">
          {sidebar}
        </div>
      </Sheet>

      {/* ── Content area ────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-smoke-200 px-4 md:px-6">
          {/* Mobile hamburger — visible only below md */}
          <button
            type="button"
            onClick={() => setIsMobileOpen(true)}
            className="mr-3 flex items-center justify-center rounded-sm p-1.5 text-smoke-400 hover:bg-smoke-100 hover:text-charcoal-700 transition-all duration-500 md:hidden"
            aria-label="Abrir menu"
          >
            <Menu className="h-5 w-5" />
          </button>

          {/* Header content (right-aligned) */}
          <div className="flex flex-1 items-center justify-end gap-3">
            {header}
          </div>
        </header>

        {/* Main content */}
        <main
          id="main-content"
          className="flex-1 overflow-y-auto bg-smoke-100/50 px-4 py-4 md:px-6 md:py-6"
        >
          {children}
        </main>
      </div>
    </div>
  )
}
