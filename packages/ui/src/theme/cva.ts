/**
 * Centralized CVA presets — the authority layer for component variants.
 *
 * Workers MUST import from here instead of defining their own cva() calls.
 * Only atoms in packages/ui/src/atoms/ may define additional component-specific
 * CVA variants (e.g., buttonVariants, badgeVariants).
 */

import { cva } from 'class-variance-authority'

/* ── Form field variants ────────────────────────────────────────────── */

export const fieldVariants = cva(
  'w-full rounded-md border transition-colors outline-none',
  {
    variants: {
      size: {
        sm: 'h-8 px-2 text-sm',
        md: 'h-10 px-3 text-base',
        lg: 'h-12 px-4 text-lg',
      },
      state: {
        default:
          'border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-[var(--color-text-primary)] ' +
          'placeholder:text-[var(--color-text-disabled)] ' +
          'focus:ring-2 focus:ring-brand-500 focus:border-brand-500',
        error:
          'border-accent-red bg-[var(--color-surface-elevated)] text-[var(--color-text-primary)] ' +
          'focus:ring-2 focus:ring-accent-red focus:border-accent-red',
        disabled:
          'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-text-disabled)] ' +
          'cursor-not-allowed',
      },
    },
    defaultVariants: {
      size: 'md',
      state: 'default',
    },
  }
)

/* ── Overlay position variants ──────────────────────────────────────── */

export const overlayVariants = cva('fixed z-50', {
  variants: {
    position: {
      center: 'inset-0 flex items-center justify-center',
      right: 'top-0 right-0 bottom-0',
      left: 'top-0 left-0 bottom-0',
      bottom: 'bottom-0 left-0 right-0',
    },
  },
})

/* ── Overlay size variants (Modal/Sheet widths) ─────────────────────── */

export const overlaySizeVariants = cva('', {
  variants: {
    size: {
      sm: 'max-w-sm',
      md: 'max-w-md',
      lg: 'max-w-lg',
      xl: 'max-w-xl',
      full: 'max-w-full',
    },
  },
  defaultVariants: {
    size: 'md',
  },
})

/* ── Toast type variants ────────────────────────────────────────────── */

export const toastVariants = cva(
  'rounded-lg border flex items-center gap-2 shadow-md animate-fade-up',
  {
    variants: {
      type: {
        success: 'bg-green-50 border-green-300 text-green-900',
        error: 'bg-red-50 border-red-300 text-red-900',
        warning: 'bg-yellow-50 border-yellow-300 text-yellow-900',
        info: 'bg-blue-50 border-blue-300 text-blue-900',
        cart: 'bg-charcoal-900 border-transparent text-smoke-50',
      },
      compact: {
        true: 'max-w-[280px] px-3 py-2',
        false: 'max-w-sm px-4 py-3',
      },
    },
    defaultVariants: {
      type: 'info',
      compact: false,
    },
  }
)
