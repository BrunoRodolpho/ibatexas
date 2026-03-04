"use client"

import { useUIStore } from "@/stores"
import { ToastContainer } from "@/components/molecules"

export function ToastProvider() {
  const toasts = useUIStore((s) => s.toasts)
  const removeToast = useUIStore((s) => s.removeToast)

  // Bridge toast shape → ToastProps by injecting onClose
  const toastProps = toasts.map((t) => ({ ...t, onClose: removeToast }))

  return <ToastContainer toasts={toastProps} onClose={removeToast} />
}
