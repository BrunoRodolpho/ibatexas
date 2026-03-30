import type { ReactNode } from 'react'

/* ── Shared primitives ─────────────────────────────────────────────── */

export type Size = 'sm' | 'md' | 'lg'
export type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ColorScheme = 'light' | 'dark'

/* ── Form field contract ───────────────────────────────────────────── */

/**
 * Base props that every form field atom must accept.
 * Workers MUST extend this — not redefine field prop shapes.
 */
export interface BaseFieldProps {
  /** If omitted, auto-generated via useId() inside the component */
  id?: string
  label?: string
  /** Error message — renders in red below the field */
  error?: string
  /** Hint text — renders in muted below the field */
  hint?: string
  disabled?: boolean
  required?: boolean
  className?: string
}

/* ── Overlay contract ──────────────────────────────────────────────── */

/**
 * Base props for any overlay (Modal, Sheet, Drawer).
 * Workers MUST extend this — not redefine overlay prop shapes.
 */
export interface BaseOverlayProps {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  /** Accessible title — used for aria-labelledby */
  title: string
}

/* ── ProductCard strict data model ─────────────────────────────────── */

/**
 * UI-facing product data — decoupled from backend DTOs.
 * Mappers at the boundary convert ProductDTO → ProductCardData.
 */
export interface ProductCardData {
  id: string
  title: string
  subtitle?: string
  imageUrl: string
  images?: string[]
  /** Price in centavos (8900 = R$89,00) */
  price: number
  /** Strike-through price in centavos */
  compareAtPrice?: number
  rating?: number
  reviewCount?: number
  tags?: string[]
  weight?: string
  servings?: number
  stockCount?: number
  availabilityWindow?: string
  isBundle?: boolean
  bundleServings?: number
  href: string
  /** Today's order count — shown as scarcity signal when >= 5 */
  ordersToday?: number
}

export interface CartState {
  quantity: number
  isLoading?: boolean
}

export interface CardCallbacks {
  onAddToCart?: () => void
  onUpdateQuantity?: (qty: number) => void
  onRemoveFromCart?: () => void
}

/* ── Toast contract ────────────────────────────────────────────────── */

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'cart'
export type ToastPosition = 'top-right' | 'bottom-right' | 'bottom-center'

export interface ToastData {
  id: string
  type: ToastType
  message: string
  /** Optional title for richer toasts */
  title?: string
  /** 0 = persistent (user must dismiss). Default varies by type. */
  duration?: number
  /** Custom icon — overrides default type icon */
  icon?: ReactNode
  /** Key for deduplication — same key updates existing toast */
  dedupeKey?: string
}

/* ── Admin callback contract ───────────────────────────────────────── */

export interface AdminActionCallbacks {
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

/* ── Auth state contract ───────────────────────────────────────────── */

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'
