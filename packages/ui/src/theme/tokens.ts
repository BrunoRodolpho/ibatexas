/**
 * Design tokens — single source of truth for the IbateXas design system.
 *
 * Two formats:
 *  - `semantic` → CSS custom property refs, usable in JS logic, charts, inline styles
 *  - `tw`       → Tailwind utility classes for component JSX
 *
 * Workers MUST import from here. Never hardcode color/spacing values in components.
 */

/* ── Semantic (CSS variable references) ─────────────────────────────── */

export const semantic = {
  text: {
    primary: 'var(--color-text-primary)',
    secondary: 'var(--color-text-secondary)',
    muted: 'var(--color-text-muted)',
    disabled: 'var(--color-text-disabled)',
    inverse: 'var(--color-text-inverse)',
  },
  bg: {
    surface: 'var(--color-surface)',
    elevated: 'var(--color-surface-elevated)',
    muted: 'var(--color-surface-muted)',
    overlay: 'var(--color-overlay)',
  },
  border: {
    default: 'var(--color-border)',
    strong: 'var(--color-border-strong)',
  },
  brand: {
    primary: 'var(--color-brand-500)',
    hover: 'var(--color-brand-600)',
  },
} as const

/* ── Tailwind utility classes (for component JSX) ───────────────────── */

export const tw = {
  text: {
    primary: 'text-[var(--color-text-primary)]',
    secondary: 'text-[var(--color-text-secondary)]',
    muted: 'text-[var(--color-text-muted)]',
    disabled: 'text-[var(--color-text-disabled)]',
    inverse: 'text-[var(--color-text-inverse)]',
  },
  bg: {
    surface: 'bg-[var(--color-surface)]',
    elevated: 'bg-[var(--color-surface-elevated)]',
    muted: 'bg-[var(--color-surface-muted)]',
    overlay: 'bg-[var(--color-overlay)]',
  },
  border: {
    default: 'border-[var(--color-border)]',
    strong: 'border-[var(--color-border-strong)]',
  },
  focus: {
    ring: 'focus:ring-2 focus:ring-brand-500 focus:border-brand-500',
  },
} as const

/* ── Spacing constants (editorial rhythm) ───────────────────────────── */

export const spacing = {
  /** Standard admin content padding per breakpoint */
  admin: {
    mobile: 'px-4 py-4',
    tablet: 'px-5 py-5',
    desktop: 'px-6 py-6',
  },
} as const

/* ── Transition presets ─────────────────────────────────────────────── */

export const transition = {
  luxury: 'transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]',
  fast: 'transition-colors duration-200',
} as const
