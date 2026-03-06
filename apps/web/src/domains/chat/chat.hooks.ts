"use client"

import { apiFetch, apiStream } from "@/lib/api"
import { useChatStore } from './chat.store'
import { useSessionStore } from '@/domains/session'

// ── Stream chunk types ──────────────────────────────────────────────────

type StreamChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

function isStreamChunk(value: unknown): value is StreamChunk {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return obj.type === 'text_delta' || obj.type === 'error' || obj.type === 'done'
}

// ── Helpers ─────────────────────────────────────────────────────────────

let msgCounter = 0

function buildUserMessage(content: string) {
  return {
    id: `msg_${Date.now()}_${++msgCounter}_user`,
    role: 'user' as const,
    content,
    timestamp: new Date(),
  }
}

function buildAssistantPlaceholder() {
  return {
    id: `msg_${Date.now()}_${++msgCounter}_assistant`,
    role: 'assistant' as const,
    content: '',
    timestamp: new Date(),
  }
}

// ── Chat Hook ───────────────────────────────────────────────────────────

export function useChat() {
  const addMessage = useChatStore((s) => s.addMessage)
  const updateLastMessage = useChatStore((s) => s.updateLastMessage)
  const setLoading = useChatStore((s) => s.setLoading)
  const setError = useChatStore((s) => s.setError)
  const sessionId = useSessionStore((s) => s.sessionId)

  const sendMessage = async (content: string) => {
    if (!sessionId) {
      setError("Sessão não inicializada")
      return
    }

    addMessage(buildUserMessage(content))
    setLoading(true)
    setError(undefined)

    try {
      await apiFetch("/api/chat/messages", {
        method: "POST",
        body: JSON.stringify({ sessionId, message: content, channel: "web" }),
      })

      addMessage(buildAssistantPlaceholder())

      await apiStream(`/api/chat/stream/${sessionId}`, (raw: unknown) => {
        if (!isStreamChunk(raw)) return
        switch (raw.type) {
          case 'text_delta':  updateLastMessage(raw.delta); break
          case 'error':       setError(raw.message);        break
          case 'done':        setLoading(false);             break
        }
      })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Erro desconhecido"
      setError(errorMsg)
      setLoading(false)
    }
  }

  return { sendMessage }
}
