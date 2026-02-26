"use client"

import { useToastStore } from "@/stores/useToastStore"
import { ToastContainer } from "@/components/molecules"

export function ToastProvider() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  // Bridge ToastItem → ToastProps by injecting onClose
  const toastProps = toasts.map((t) => ({ ...t, onClose: removeToast }))

  return <ToastContainer toasts={toastProps} onClose={removeToast} />
}
