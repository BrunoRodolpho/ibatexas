'use client'

import { useLocale, useTranslations } from 'next-intl'
import { useSessionStore } from '@/stores'
import { AdminSidebar } from '@/components/molecules/AdminSidebar'
import { Button } from '@/components/atoms'
import { LogOut, Shield } from 'lucide-react'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations()
  const locale = useLocale()
  const { userType, customerId, setCustomer, logout } = useSessionStore()

  // ── Auth stub (replaced in Step 11 with real Twilio OTP) ──────────────────
  if (userType !== 'staff') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
            <Shield className="h-7 w-7 text-amber-700" />
          </div>
          <h1 className="text-xl font-bold text-slate-900">{t('admin.login_required')}</h1>
          <p className="mt-2 text-sm text-slate-500">
            {t('admin.login_description')}
          </p>

          {/* Dev bypass — REMOVED in Step 11 */}
          {process.env.NODE_ENV !== 'production' && (
            <div className="mt-6 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-4">
              <p className="mb-3 text-xs font-medium text-amber-700">
                🔧 Dev mode — bypass auth
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
    <div className="flex h-screen overflow-hidden bg-slate-50">
      <AdminSidebar />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Admin header bar */}
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
          <div />
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-500">
              {customerId ?? 'Staff'}
            </span>
            <Button
              variant="tertiary"
              size="sm"
              onClick={() => logout()}
              className="gap-1.5"
            >
              <LogOut className="h-4 w-4" />
              {t('account.logout')}
            </Button>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
