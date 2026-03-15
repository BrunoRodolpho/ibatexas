"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useSessionStore } from '@/domains/session'
import { getApiBase } from "@/lib/api"
import { Heading, Text, Button } from "@/components/atoms"
import { Smartphone } from "lucide-react"

type Step = "phone" | "code"

const COUNTRY_CODES = [
  { code: "+55", label: "🇧🇷 +55", maxDigits: 11, placeholder: "(11) 99999-9999" },
  { code: "+1", label: "🇺🇸 +1", maxDigits: 10, placeholder: "(217) 417-4509" },
] as const

// ── Phone mask by country ───────────────────────────────────────────────
function formatPhone(value: string, countryCode: string): string {
  if (countryCode === "+55") {
    const digits = value.replaceAll(/\D/g, "").slice(0, 11)
    if (digits.length <= 2) return digits
    if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`
  }
  // US format: (XXX) XXX-XXXX
  const digits = value.replaceAll(/\D/g, "").slice(0, 10)
  if (digits.length <= 3) return digits
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}

export default function EntrarPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const nextPath = searchParams.get("next") ?? "/"
  const { login } = useSessionStore()

  const [step, setStep] = useState<Step>("phone")
  const [phone, setPhone] = useState("")
  const [countryCode, setCountryCode] = useState("+55")
  const [otp, setOtp] = useState(["", "", "", "", "", ""])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const otpRefs = useRef<(HTMLInputElement | null)[]>([])
  const rawPhone = phone.replaceAll(/\D/g, "")
  const selectedCountry = COUNTRY_CODES.find((c) => c.code === countryCode) ?? COUNTRY_CODES[0]

  // Auto-focus first OTP input
  useEffect(() => {
    if (step === "code") {
      otpRefs.current[0]?.focus()
    }
  }, [step])

  async function handleSendOtp(e?: React.FormEvent) {
    e?.preventDefault()
    if (rawPhone.length < 10) {
      setError("Informe um número de celular válido")
      return
    }
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${getApiBase()}/api/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: `${countryCode}${rawPhone}` }),
        credentials: "include",
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string }
        throw new Error(data.message ?? "Erro ao enviar código.")
      }
      setStep("code")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao enviar código.")
    } finally {
      setLoading(false)
    }
  }

  const handleVerifyOtp = useCallback(
    async (code: string) => {
      setError(null)
      setLoading(true)
      try {
        const res = await fetch(`${getApiBase()}/api/auth/verify-otp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: `${countryCode}${rawPhone}`, code }),
          credentials: "include",
        })
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string }
          throw new Error(data.message ?? "Código inválido.")
        }
        const data = (await res.json()) as { id: string; phone: string; name: string | null; email: string | null }
        login(data.id)
        router.push(nextPath)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Código inválido.")
        setOtp(["", "", "", "", "", ""])
        otpRefs.current[0]?.focus()
      } finally {
        setLoading(false)
      }
    },
    [countryCode, rawPhone, login, router, nextPath],
  )

  // ── OTP digit input handler ───────────────────────────────────────────
  const handleOTPChange = (index: number, value: string) => {
    if (!/^\d*$/.test(value)) return
    const newOtp = [...otp]
    newOtp[index] = value.slice(-1)
    setOtp(newOtp)

    // Auto-advance
    if (value && index < 5) {
      otpRefs.current[index + 1]?.focus()
    }

    // Auto-submit when all 6 digits entered
    const fullCode = newOtp.join("")
    if (fullCode.length === 6) {
      handleVerifyOtp(fullCode)
    }
  }

  const handleOTPKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      otpRefs.current[index - 1]?.focus()
    }
  }

  const handleOTPPaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const pasted = e.clipboardData.getData("text").replaceAll(/\D/g, "").slice(0, 6)
    if (pasted.length === 0) return

    const newOtp = ["", "", "", "", "", ""]
    for (let i = 0; i < pasted.length; i++) {
      newOtp[i] = pasted[i]
    }
    setOtp(newOtp)

    if (pasted.length === 6) {
      handleVerifyOtp(pasted)
    } else {
      otpRefs.current[pasted.length]?.focus()
    }
  }

  return (
    <div className="min-h-screen bg-smoke-100 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <span className="font-display text-2xl font-bold tracking-wide text-charcoal-900">
            Ibate<span className="text-brand-500">X</span>as
          </span>
        </div>

        <div className="bg-smoke-50 rounded-sm border border-smoke-200 p-8 shadow-sm">
          {step === "phone" ? (
            <>
              {/* ── Step 1: Phone Input ────────────────────────────── */}
              <div className="flex justify-center mb-6">
                <div className="w-12 h-12 rounded-full bg-smoke-100 flex items-center justify-center">
                  <Smartphone className="w-5 h-5 text-smoke-400" strokeWidth={1.5} />
                </div>
              </div>

              <Heading as="h1" variant="h3" className="text-center text-charcoal-900 mb-2">
                Entrar
              </Heading>
              <Text variant="small" textColor="muted" className="text-center mb-8">
                Enviaremos um código via WhatsApp
              </Text>

              <form onSubmit={handleSendOtp} className="space-y-4">
                <div>
                  <label htmlFor="phone-input" className="block text-xs font-medium uppercase tracking-editorial text-smoke-400 mb-1.5">
                    Celular
                  </label>
                  <div className="flex items-center border border-smoke-200 rounded-sm overflow-hidden focus-within:border-charcoal-900 transition-colors duration-300">
                    <select
                      value={countryCode}
                      onChange={(e) => {
                        setCountryCode(e.target.value)
                        setPhone("")
                      }}
                      className="px-2 text-sm text-smoke-500 bg-smoke-100 border-r border-smoke-200 py-2.5 outline-none cursor-pointer"
                    >
                      {COUNTRY_CODES.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <input
                      id="phone-input"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(formatPhone(e.target.value, countryCode))}
                      placeholder={selectedCountry.placeholder}
                      className="flex-1 px-3 py-2.5 text-sm text-charcoal-900 bg-transparent outline-none placeholder:text-smoke-300"
                      autoFocus
                    />
                  </div>
                </div>

                {error && <p className="text-xs text-accent-red">{error}</p>}

                <Button
                  type="submit"
                  isLoading={loading}
                  disabled={rawPhone.length < 10}
                  className="w-full"
                  size="lg"
                >
                  Enviar código
                </Button>
              </form>
            </>
          ) : (
            <>
              {/* ── Step 2: OTP Input ─────────────────────────────── */}
              <Heading as="h1" variant="h3" className="text-center text-charcoal-900 mb-2">
                Código de verificação
              </Heading>
              <Text variant="small" textColor="muted" className="text-center mb-8">
                Enviamos um código para {countryCode} {phone}
              </Text>

              <div className="space-y-6">
                <div className="flex justify-center gap-2" onPaste={handleOTPPaste}>
                  {otp.map((digit, index) => (
                    <input
                      key={`otp-${index}`}
                      ref={(el) => {
                        otpRefs.current[index] = el
                      }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleOTPChange(index, e.target.value)}
                      onKeyDown={(e) => handleOTPKeyDown(index, e)}
                      className="w-11 h-12 border border-smoke-200 rounded-sm text-center text-lg font-semibold text-charcoal-900 focus:border-charcoal-900 focus:outline-none transition-colors duration-300"
                      aria-label={`Dígito ${index + 1}`}
                    />
                  ))}
                </div>

                {error && <p className="text-xs text-accent-red text-center">{error}</p>}

                {loading && (
                  <div className="flex justify-center">
                    <div className="w-5 h-5 border-2 border-smoke-200 border-t-charcoal-900 rounded-full animate-spin" />
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => {
                    setStep("phone")
                    setOtp(["", "", "", "", "", ""])
                    setError(null)
                  }}
                  className="block mx-auto text-xs text-smoke-400 hover:text-charcoal-900 transition-colors duration-300"
                >
                  ← Alterar número
                </button>

                <button
                  type="button"
                  onClick={() => handleSendOtp()}
                  className="block mx-auto text-xs text-brand-500 hover:text-brand-600 transition-colors duration-300"
                  disabled={loading}
                >
                  Reenviar código
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
