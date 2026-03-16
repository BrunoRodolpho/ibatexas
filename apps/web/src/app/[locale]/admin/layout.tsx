'use client'

/**
 * @deprecated Admin UI has moved to apps/admin (port 3002).
 * These routes remain temporarily for backward compatibility.
 * Remove once the team has fully migrated to the standalone admin app.
 */

import { useTranslations } from 'next-intl'
import { useSessionStore } from '@/domains/session'
import { AdminSidebar } from '@/components/molecules/AdminSidebar'
import { Button } from '@/components/atoms'
import { LogOut, Shield, Search } from 'lucide-react'

export default function AdminLayout({ children }: { readonly children: React.ReactNode }) {
  const t = useTranslations()
  const { userType, customerId, setCustomer, logout } = useSessionStore()

  // ── Auth stub (replaced in Step 11 with real Twilio OTP) ──────────────────
  if (userType !== 'staff') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-smoke-50 p-4">
        <div className="w-full max-w-sm rounded-sm border border-smoke-200 bg-smoke-50 p-8 text-center shadow-xs">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-sm bg-smoke-100">
            <Shield className="h-5 w-5 text-charcoal-700" />
          </div>
          <h1 className="text-lg font-semibold text-charcoal-900">{t('admin.login_required')}</h1>
          <p className="mt-2 text-sm text-smoke-400">
            {t('admin.login_description')}
          </p>

          {/* Dev bypass — REMOVED in Step 11 */}
          {process.env.NODE_ENV !== 'production' && (
            <div className="mt-6 rounded-sm border border-dashed border-smoke-300 bg-smoke-100 p-4">
              <p className="mb-3 text-xs font-medium text-smoke-400">
                Dev mode — bypass auth
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={() => setCustomer('dev-admin', 'staff')}
              >
                Entrar como Staff (dev)
              </Button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-smoke-50">
      <AdminSidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Admin header bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-smoke-200 px-6">
          {/* Search */}
          <div className="flex items-center gap-2 rounded-sm border border-smoke-200 bg-smoke-100 px-3 py-1.5">
            <Search className="h-3.5 w-3.5 text-smoke-300" />
            <span className="text-[13px] text-smoke-300">Buscar...</span>
            <kbd className="ml-4 rounded-sm border border-smoke-200 bg-smoke-50 px-1.5 py-0.5 text-[10px] font-medium text-smoke-300">
              ⌘K
            </kbd>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[13px] text-smoke-400">
              {customerId ?? 'Staff'}
            </span>
            <div className="h-4 w-px bg-smoke-200" />
            <button
              onClick={() => logout()}
              className="flex items-center gap-1.5 text-[13px] font-medium text-smoke-400 hover:text-charcoal-700 transition-colors"
            >
              <LogOut className="h-3.5 w-3.5" />
              {t('account.logout')}
            </button>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto bg-smoke-100/50 p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
