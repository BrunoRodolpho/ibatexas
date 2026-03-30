'use client'

import { useCallback, useRef, useState } from 'react'

/* ── Public API types ──────────────────────────────────────────────── */

/**
 * Validator function — returns a map of field name to error message,
 * or `null` if all values are valid.
 *
 * This is validation-library-agnostic: wrap Zod, Yup, or anything else
 * into this shape in the consuming app.
 */
export type FormValidator<T extends Record<string, unknown>> = (
  values: T,
) => Record<string, string> | null

export interface UseFormOptions<T extends Record<string, unknown>> {
  /** Validation function — return `{ field: "message" }` or `null` if valid */
  validate: FormValidator<T>
  /** Initial field values */
  defaultValues: T
}

export interface FieldRegistration {
  value: string
  onChange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => void
  onBlur: () => void
  /** Matches `BaseFieldProps.error` — renders below the field */
  error?: string
}

export interface UseFormReturn<T extends Record<string, unknown>> {
  /** Spread onto a field atom: `<TextField {...register('name')} />` */
  register: (name: keyof T & string) => FieldRegistration
  /** Wraps your submit handler with validation + loading state */
  handleSubmit: (
    onSubmit: (data: T) => void | Promise<void>,
  ) => (e?: React.FormEvent) => void
  /** Current per-field errors */
  errors: Partial<Record<keyof T & string, string>>
  /** Current field values */
  values: T
  /** True while the `onSubmit` promise is in-flight */
  isSubmitting: boolean
  /** True when any field differs from its default */
  isDirty: boolean
  /** Reset to defaults (or partial override). Clears errors. */
  reset: (newDefaults?: Partial<T>) => void
  /** Programmatically set a single field value */
  setValue: (name: keyof T & string, value: unknown) => void
}

/* ── Hook implementation ──────────────────────────────────────────── */

/**
 * Lightweight form hook for the IbateXas design system.
 *
 * Integrates with any field atom that accepts `BaseFieldProps` (`error` prop).
 * Validation is library-agnostic — pass a `validate` function that returns
 * `{ field: "message" }` or `null`.
 *
 * @example
 * ```ts
 * const { register, handleSubmit, isSubmitting } = useForm({
 *   defaultValues: { name: '', email: '' },
 *   validate: zodValidate(mySchema),
 * })
 *
 * <form onSubmit={handleSubmit(onSave)}>
 *   <TextField label="Nome" {...register('name')} />
 *   <TextField label="Email" {...register('email')} />
 *   <Button type="submit" loading={isSubmitting}>Salvar</Button>
 * </form>
 * ```
 */
export function useForm<T extends Record<string, unknown>>(
  options: UseFormOptions<T>,
): UseFormReturn<T> {
  const { validate, defaultValues } = options

  const [values, setValues] = useState<T>({ ...defaultValues })
  const [errors, setErrors] = useState<Partial<Record<keyof T & string, string>>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDirty, setIsDirty] = useState(false)

  /* Keep a stable ref to defaults so reset() always uses the latest */
  const defaultsRef = useRef<T>({ ...defaultValues })

  /* ── Helpers ────────────────────────────────────────────────────── */

  const validateField = useCallback(
    (name: keyof T & string, currentValues: T) => {
      const result = validate(currentValues)
      setErrors((prev) => {
        const next = { ...prev }
        if (result && name in result) {
          next[name] = result[name]
        } else {
          delete next[name]
        }
        return next
      })
    },
    [validate],
  )

  const computeDirty = useCallback(
    (nextValues: T) => {
      const defaults = defaultsRef.current
      for (const key of Object.keys(defaults)) {
        if (nextValues[key] !== defaults[key]) return true
      }
      return false
    },
    [],
  )

  /* ── register ──────────────────────────────────────────────────── */

  const register = useCallback(
    (name: keyof T & string): FieldRegistration => ({
      value: String(values[name] ?? ''),
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
      ) => {
        const nextValue = e.target.value
        setValues((prev) => {
          const next = { ...prev, [name]: nextValue } as T
          setIsDirty(computeDirty(next))
          return next
        })
        /* Clear the field error on change so the user gets immediate feedback */
        setErrors((prev) => {
          if (!(name in prev)) return prev
          const next = { ...prev }
          delete next[name]
          return next
        })
      },
      onBlur: () => {
        /* Field-level validation on blur */
        validateField(name, values)
      },
      error: errors[name],
    }),
    [values, errors, validateField, computeDirty],
  )

  /* ── handleSubmit ──────────────────────────────────────────────── */

  const handleSubmit = useCallback(
    (onSubmit: (data: T) => void | Promise<void>) =>
      (e?: React.FormEvent) => {
        if (e) e.preventDefault()

        const result = validate(values)
        if (result) {
          setErrors(result as Partial<Record<keyof T & string, string>>)
          return
        }

        setErrors({})
        setIsSubmitting(true)

        const maybePromise = onSubmit(values)
        if (maybePromise instanceof Promise) {
          maybePromise.finally(() => setIsSubmitting(false))
        } else {
          setIsSubmitting(false)
        }
      },
    [validate, values],
  )

  /* ── reset ─────────────────────────────────────────────────────── */

  const reset = useCallback(
    (newDefaults?: Partial<T>) => {
      const merged = { ...defaultsRef.current, ...newDefaults } as T
      defaultsRef.current = merged
      setValues(merged)
      setErrors({})
      setIsDirty(false)
    },
    [],
  )

  /* ── setValue ───────────────────────────────────────────────────── */

  const setValue = useCallback(
    (name: keyof T & string, value: unknown) => {
      setValues((prev) => {
        const next = { ...prev, [name]: value } as T
        setIsDirty(computeDirty(next))
        return next
      })
    },
    [computeDirty],
  )

  return { register, handleSubmit, errors, values, isSubmitting, isDirty, reset, setValue }
}
