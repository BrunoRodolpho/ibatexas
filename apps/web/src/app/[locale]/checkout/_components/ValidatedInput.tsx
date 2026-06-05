"use client"

import type { InputHTMLAttributes } from "react"

interface ValidatedInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Already-translated error message. When set, the field shows a red border + inline message. */
  error?: string
}

const BASE =
  "w-full border-0 border-b bg-transparent rounded-none px-1 py-3 text-sm focus:outline-none transition-[border-color] duration-[200ms] ease-luxury"

/**
 * Underline-style text input matching the checkout aesthetic, with built-in
 * touched/invalid feedback: a red bottom border and an inline error message
 * (announced politely) when `error` is set. Purely presentational — the parent
 * owns the value, the touched state, and the (already-translated) error string.
 */
export function ValidatedInput({ error, id, className, ...props }: ValidatedInputProps) {
  const borderClass = error
    ? "border-accent-red focus:border-accent-red"
    : "border-smoke-300 focus:border-charcoal-900"

  return (
    <div>
      <input
        {...props}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error && id ? `${id}-error` : undefined}
        className={`${BASE} ${borderClass}${className ? ` ${className}` : ""}`}
      />
      <div aria-live="polite" aria-atomic="true">
        {error && (
          <p id={id ? `${id}-error` : undefined} className="text-xs text-accent-red mt-1">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
