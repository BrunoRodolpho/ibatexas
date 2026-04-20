'use client'

import { useThemeStore } from '@/stores/theme'

const themeConfig = {
  light: { icon: '\u2600\uFE0F', label: 'Modo claro', next: 'dark' as const },
  dark:  { icon: '\uD83C\uDF19', label: 'Modo escuro', next: 'system' as const },
  system: { icon: '\uD83D\uDCBB', label: 'Tema do sistema', next: 'light' as const },
}

export function ThemeToggle({ className }: { readonly className?: string }) {
  const { theme, setTheme } = useThemeStore()
  const { icon, label, next } = themeConfig[theme]

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className={[
        'inline-flex items-center justify-center w-10 h-10 rounded-sm',
        'text-lg transition-all duration-500',
        'hover:bg-smoke-100 active:bg-smoke-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
        className,
      ].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  )
}
