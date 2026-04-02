'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AdminSidebar } from '@/components/molecules/AdminSidebar'
import { LogOut, Shield, Search, Loader2 } from 'lucide-react'
import { ToastContainer, AdminLayout as AdminLayoutShell, useToast, setupGlobalErrorCapture } from '@ibatexas/ui'

/* ── Types ──────────────────────────────────────────────────────────── */

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'
type LoginStep = 'phone' | 'otp'

/* ── Cookie helpers ─────────────────────────────────────────────────── */

function getCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match ? decodeURIComponent(match[1]) : undefined
}

function setCookie(name: string, value: string, maxAge: number): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`
}

function deleteCookie(name: string): void {
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Lax`
}

/* ── Session check ──────────────────────────────────────────────────── */

function checkSession(): AuthStatus {
  return getCookie('admin-session') ? 'authenticated' : 'unauthenticated'
}

/* ── Phone formatting helpers ───────────────────────────────────────── */

type CountryCode = 'BR' | 'US'

const COUNTRY_CONFIG: Record<CountryCode, { code: string; flag: string; maxDigits: number; minDigits: number; placeholder: string }> = {
  BR: { code: '+55', flag: '🇧🇷', maxDigits: 11, minDigits: 10, placeholder: '(11) 99999-9999' },
  US: { code: '+1', flag: '🇺🇸', maxDigits: 10, minDigits: 10, placeholder: '(512) 555-1234' },
}

/** Mask raw digits into country-appropriate format as the user types. */
function formatPhone(raw: string, country: CountryCode): string {
  const { maxDigits } = COUNTRY_CONFIG[country]
  const digits = raw.replace(/\D/g, '').slice(0, maxDigits)

  if (country === 'BR') {
    if (digits.length <= 2) return digits
    if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
  }

  // US: (XXX) XXX-XXXX
  if (digits.length <= 3) return digits
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}

/** Strip formatting to get E.164 phone with country prefix. */
function toE164(formatted: string, country: CountryCode): string {
  const digits = formatted.replace(/\D/g, '')
  return `${COUNTRY_CONFIG[country].code}${digits}`
}

/* ── Skeleton ───────────────────────────────────────────────────────── */

function AdminSkeleton() {
  return (
    <div className="flex h-screen overflow-hidden bg-smoke-50">
      {/* Sidebar skeleton */}
      <div className="hidden md:flex w-16 lg:w-[240px] flex-col border-r border-smoke-200 bg-smoke-50 p-4 gap-4">
        <div className="h-8 rounded-sm bg-smoke-200 animate-pulse" />
        <div className="h-6 w-3/4 rounded-sm bg-smoke-200 animate-pulse" />
        <div className="h-6 w-2/3 rounded-sm bg-smoke-200 animate-pulse" />
        <div className="h-6 w-3/4 rounded-sm bg-smoke-200 animate-pulse" />
        <div className="mt-4 h-6 w-1/2 rounded-sm bg-smoke-200 animate-pulse" />
        <div className="h-6 w-3/4 rounded-sm bg-smoke-200 animate-pulse" />
      </div>

      {/* Content skeleton */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center border-b border-smoke-200 px-6">
          <div className="h-8 w-48 rounded-sm bg-smoke-200 animate-pulse" />
        </header>
        <main className="flex-1 overflow-y-auto bg-smoke-100/50 p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 rounded-sm bg-smoke-200 animate-pulse" />
            ))}
          </div>
          <div className="mt-6 h-64 rounded-sm bg-smoke-200 animate-pulse" />
        </main>
      </div>
    </div>
  )
}

/* ── Login Form ─────────────────────────────────────────────────────── */

function LoginForm({ onSuccess }: { readonly onSuccess: () => void }) {
  const { addToast } = useToast()
  const [step, setStep] = useState<LoginStep>('phone')
  const [country, setCountry] = useState<CountryCode>('BR')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)

  const otpInputRef = useRef<HTMLInputElement>(null)

  // Auto-focus OTP input when switching to OTP step
  useEffect(() => {
    if (step === 'otp') {
      otpInputRef.current?.focus()
    }
  }, [step])

  const handleSendOtp = async () => {
    const digits = phone.replace(/\D/g, '')
    const { minDigits } = COUNTRY_CONFIG[country]
    if (digits.length < minDigits) {
      addToast({ type: 'warning', message: 'Digite um telefone válido com DDD.' })
      return
    }
    const e164 = toE164(phone, country)

    setLoading(true)
    try {
      const res = await fetch('/api/proxy/auth/staff/send-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: e164 }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: 'Erro ao enviar código.' }))
        addToast({ type: 'error', message: body.message ?? 'Erro ao enviar código.' })
        return
      }

      addToast({ type: 'success', message: 'Código enviado! Verifique seu WhatsApp.' })
      setStep('otp')
    } catch {
      addToast({ type: 'error', message: 'Falha de rede. Tente novamente.' })
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyOtp = async () => {
    if (code.length !== 6) {
      addToast({ type: 'warning', message: 'O código deve ter 6 dígitos.' })
      return
    }

    setLoading(true)
    try {
      const e164 = toE164(phone, country)
      const res = await fetch('/api/proxy/auth/staff/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: e164, code }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: 'Código inválido.' }))
        addToast({ type: 'error', message: body.message ?? 'Código inválido.' })
        return
      }

      // Set admin-session cookie so middleware allows access
      // The API sets the httpOnly "token" cookie, but the middleware checks "admin-session"
      setCookie('admin-session', '1', 8 * 60 * 60) // 8h — matches staff JWT expiry
      // Signal cross-tab login
      localStorage.setItem('admin-session-sync', Date.now().toString())

      addToast({ type: 'success', message: 'Autenticado com sucesso!' })
      onSuccess()
    } catch {
      addToast({ type: 'error', message: 'Falha de rede. Tente novamente.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-smoke-50 p-4">
      <div className="w-full max-w-sm rounded-sm border border-smoke-200 bg-smoke-50 p-8 shadow-xs">
        {/* Branding */}
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-sm bg-smoke-100">
            <Shield className="h-5 w-5 text-charcoal-700" />
          </div>
          <h1 className="text-lg font-semibold text-charcoal-900">Acesso restrito</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Este painel é exclusivo para a equipe IbateXas.
          </p>
        </div>

        {step === 'phone' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleSendOtp()
            }}
            className="space-y-4"
          >
            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-charcoal-700 mb-1">
                Telefone
              </label>
              <div className="flex gap-2">
                <select
                  value={country}
                  onChange={(e) => {
                    const next = e.target.value as CountryCode
                    setCountry(next)
                    setPhone('')
                  }}
                  disabled={loading}
                  className="shrink-0 rounded-sm border border-smoke-200 bg-smoke-50 px-2 py-2 text-sm text-charcoal-900 focus:border-charcoal-400 focus:outline-none focus:ring-1 focus:ring-charcoal-400"
                >
                  {(Object.keys(COUNTRY_CONFIG) as CountryCode[]).map((c) => (
                    <option key={c} value={c}>{COUNTRY_CONFIG[c].flag} {c}</option>
                  ))}
                </select>
                <input
                  id="phone"
                  type="tel"
                  inputMode="numeric"
                  placeholder={COUNTRY_CONFIG[country].placeholder}
                  value={phone}
                  onChange={(e) => setPhone(formatPhone(e.target.value, country))}
                  className="w-full rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-2 text-sm text-charcoal-900 placeholder:text-smoke-400 focus:border-charcoal-400 focus:outline-none focus:ring-1 focus:ring-charcoal-400"
                  disabled={loading}
                  autoFocus
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={loading || phone.replace(/\D/g, '').length < COUNTRY_CONFIG[country].minDigits}
              className="flex w-full items-center justify-center gap-2 rounded-sm bg-charcoal-900 px-4 py-2 text-sm font-medium text-smoke-50 hover:bg-charcoal-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Enviar código
            </button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleVerifyOtp()
            }}
            className="space-y-4"
          >
            <p className="text-sm text-[var(--color-text-secondary)]">
              Código enviado para{' '}
              <span className="font-medium text-charcoal-700">{phone}</span>
            </p>
            <div>
              <label htmlFor="otp" className="block text-sm font-medium text-charcoal-700 mb-1">
                Código de verificação
              </label>
              <input
                ref={otpInputRef}
                id="otp"
                type="text"
                inputMode="numeric"
                placeholder="000000"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className="w-full rounded-sm border border-smoke-200 bg-smoke-50 px-3 py-2 text-center text-lg font-mono tracking-[0.3em] text-charcoal-900 placeholder:text-smoke-400 focus:border-charcoal-400 focus:outline-none focus:ring-1 focus:ring-charcoal-400"
                disabled={loading}
              />
            </div>
            <button
              type="submit"
              disabled={loading || code.length !== 6}
              className="flex w-full items-center justify-center gap-2 rounded-sm bg-charcoal-900 px-4 py-2 text-sm font-medium text-smoke-50 hover:bg-charcoal-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading && <Loader2 className="h-4 w-4 animate-spin" />}
              Verificar
            </button>
            <button
              type="button"
              onClick={() => {
                setStep('phone')
                setCode('')
              }}
              className="w-full text-center text-sm text-[var(--color-text-secondary)] hover:text-charcoal-700 transition-colors"
            >
              Alterar telefone
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

/* ── Header content ─────────────────────────────────────────────────── */

function AdminHeaderContent({ onLogout }: { readonly onLogout: () => void }) {
  return (
    <>
      <div className="flex items-center gap-2 rounded-sm border border-smoke-200 bg-smoke-100 px-3 py-1.5">
        <Search className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
        <span className="text-[13px] text-[var(--color-text-muted)]">Buscar...</span>
        <kbd className="ml-4 rounded-sm border border-smoke-200 bg-smoke-50 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
          ⌘K
        </kbd>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[13px] text-[var(--color-text-secondary)]">Staff</span>
        <div className="h-4 w-px bg-smoke-200" />
        <button
          type="button"
          onClick={onLogout}
          className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--color-text-secondary)] hover:text-charcoal-700 transition-colors"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sair
        </button>
      </div>
    </>
  )
}

/* ── Main Layout ────────────────────────────────────────────────────── */

/**
 * Admin layout — standalone (no next-intl, no [locale] segment).
 * Auth enforced in all environments via middleware + admin-session cookie.
 */
export default function AdminRootLayout({ children }: { readonly children: React.ReactNode }) {
  const { toasts, removeToast, addToast } = useToast()
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  /* ── Session check on mount ─────────────────────────────────────── */
  // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR requires initial 'loading' state; cookie check must run client-side only
  useEffect(() => { setAuthStatus(checkSession()) }, [])

  /* ── Session refresh interval (every 5 min) ─────────────────────── */
  useEffect(() => {
    if (authStatus !== 'authenticated') return

    intervalRef.current = setInterval(() => {
      const status = checkSession()
      if (status === 'unauthenticated') {
        setAuthStatus('unauthenticated')
        addToast({ type: 'warning', message: 'Sessão expirada. Faça login novamente.' })
      }
    }, 5 * 60 * 1000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [authStatus, addToast])

  /* ── Multi-tab sync via storage event ───────────────────────────── */
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== 'admin-session-sync') return
      // Another tab logged in or out — re-check cookie
      setAuthStatus(checkSession())
    }

    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

  /* ── Global error capture ───────────────────────────────────────── */
  useEffect(() => {
    const cleanup = setupGlobalErrorCapture()
    return cleanup
  }, [])

  /* ── Logout handler ─────────────────────────────────────────────── */
  const handleLogout = useCallback(() => {
    deleteCookie('admin-session')
    // Signal cross-tab logout
    localStorage.setItem('admin-session-sync', Date.now().toString())
    setAuthStatus('unauthenticated')
  }, [])

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <>
      <ToastContainer toasts={toasts} onClose={removeToast} position="top-right" />

      {authStatus === 'loading' && <AdminSkeleton />}

      {authStatus === 'unauthenticated' && (
        <LoginForm onSuccess={() => setAuthStatus('authenticated')} />
      )}

      {authStatus === 'authenticated' && (
        <AdminLayoutShell
          sidebar={<AdminSidebar />}
          header={<AdminHeaderContent onLogout={handleLogout} />}
        >
          {children}
        </AdminLayoutShell>
      )}
    </>
  )
}
