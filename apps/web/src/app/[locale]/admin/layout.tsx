'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useSessionStore } from '@/stores'
import { AdminSidebar } from '@/components/molecules/AdminSidebar'
import { Button } from '@/components/atoms'
import { LogOut, Shield, Search } from 'lucide-react'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations()
  const locale = useLocale()
  const { userType, customerId, setCustomer, logout } = useSessionStore()

  // ── Auth stub (replaced in Step 11 with real Twilio OTP) ──────────────────
  if (userType !== 'staff') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white p-4">
        <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 text-center shadow-xs">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100">
            <Shield className="h-5 w-5 text-slate-600" />
          </div>
          <h1 className="text-lg font-semibold text-slate-900">{t('admin.login_required')}</h1>
          <p className="mt-2 text-sm text-slate-500">
            {t('admin.login_description')}
          </p>

          {/* Dev bypass — REMOVED in Step 11 */}
          {process.env.NODE_ENV !== 'production' && (
            <div className="mt-6 rounded-md border border-dashed border-slate-300 bg-slate-50 p-4">
              <p className="mb-3 text-xs font-medium text-slate-500">
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
    <div className="flex h-screen overflow-hidden bg-white">
      <AdminSidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Admin header bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 px-6">
          {/* Search */}
          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5">
            <Search className="h-3.5 w-3.5 text-slate-400" />
            <span className="text-[13px] text-slate-400">Buscar...</span>
            <kbd className="ml-4 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
              ⌘K
            </kbd>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[13px] text-slate-500">
              {customerId ?? 'Staff'}
            </span>
            <div className="h-4 w-px bg-slate-200" />
            <button
              onClick={() => logout()}
              className="flex items-center gap-1.5 text-[13px] font-medium text-slate-500 hover:text-slate-700 transition-colors"
            >
              <LogOut className="h-3.5 w-3.5" />
              {t('account.logout')}
            </button>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto bg-slate-50/50 p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
