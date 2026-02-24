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
        className={`relative inline-flex shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600 focus-visible:ring-offset-2 ${trackSize} ${
          checked ? 'bg-amber-700' : 'bg-slate-300'
        }`}
      >
        <span
          className={`inline-block rounded-full bg-white shadow-sm transition-transform ${thumbSize} ${thumbTranslate}`}
        />
      </button>
      {label && <span className="text-sm text-slate-700">{label}</span>}
    </label>
  )
}
