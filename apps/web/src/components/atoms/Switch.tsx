'use client'

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  disabled?: boolean
  size?: 'sm' | 'md'
}

export function Switch({ checked, onChange, label, disabled = false, size = 'md' }: SwitchProps) {
  const trackSize = size === 'sm' ? 'h-4 w-7' : 'h-5 w-9'
  const thumbSize = size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'
  const thumbTranslate = size === 'sm'
    ? (checked ? 'translate-x-3' : 'translate-x-0.5')
    : (checked ? 'translate-x-4' : 'translate-x-0.5')

  return (
    <label className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`relative inline-flex shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 ${trackSize} ${
          checked ? 'bg-charcoal-900' : 'bg-smoke-300'
        }`}
      >
        <span
          className={`inline-block rounded-full bg-smoke-50 shadow-sm transition-transform duration-500 ${thumbSize} ${thumbTranslate}`}
          style={{ transitionTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1)' }}
        />
      </button>
      {label && <span className="text-sm text-charcoal-700">{label}</span>}
    </label>
  )
}
