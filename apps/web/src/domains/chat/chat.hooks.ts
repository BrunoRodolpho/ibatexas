"use client"

import { ApiError, apiFetch, apiStream } from "@/lib/api"
import { useChatStore } from './chat.store'
import { describeChatError } from './chat.errors'
import { useSessionStore } from '@/domains/session'

// ── Stream chunk types ──────────────────────────────────────────────────

type StreamChunk =
  | { type: 'text_delta'; delta: string }
  | { type: 'error'; message?: unknown; code?: unknown }
  | { type: 'done' }

/**
 * BKL-286: validate the PAYLOAD, not just the tag.
 *
 * The previous version accepted any object whose `type` matched, so a
 * `{type:"text_delta"}` with a missing or non-string `delta` appended the
 * literal "undefined" / "[object Object]" to the message bubble. That was the
 * only structurally reachable way for a non-sentence to render as chat content;
 * requiring `delta` to be a string closes it at the boundary, before the value
 * can reach the store.
 */
function isStreamChunk(value: unknown): value is StreamChunk {
  if (typeof value !== 'object' || value === null) return false
  if (!('type' in value)) return false
  const chunk = value as { type: unknown; delta?: unknown }
  if (chunk.type === 'text_delta') return typeof chunk.delta === 'string'
  return chunk.type === 'error' || chunk.type === 'done'
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
  const setErrorView = useChatStore((s) => s.setErrorView)
  const setSessionSecret = useChatStore((s) => s.setSessionSecret)
  const setSessionToken = useChatStore((s) => s.setSessionToken)
  const clearHistory = useChatStore((s) => s.clearHistory)
  const sessionId = useSessionStore((s) => s.sessionId)
  const resetSession = useSessionStore((s) => s.resetSession)

  /**
   * BKL-286 leg 2 — the recovery behind "Iniciar nova conversa": drop the dead
   * credential and the transcript it belongs to, then mint a brand-new
   * sessionId. The next POST therefore takes the server's first-request branch
   * cleanly instead of re-colliding with the session it could not authenticate.
   */
  const startNewConversation = () => {
    clearHistory()
    resetSession()
  }

  const sendMessage = async (content: string) => {
    if (!sessionId) {
      setError("Sessão não inicializada")
      return
    }

    addMessage(buildUserMessage(content))
    setLoading(true)
    setError(undefined)

    try {
      // Build ownership headers from previously stored secrets/tokens
      const { sessionSecret, sessionToken } = useChatStore.getState()
      const headers: Record<string, string> = {}
      if (sessionSecret) headers["x-session-secret"] = sessionSecret
      if (sessionToken) headers["x-session-token"] = sessionToken

      const res = await apiFetch<{ messageId: string; sessionSecret?: string; sessionToken?: string }>(
        "/api/chat/messages",
        {
          method: "POST",
          body: JSON.stringify({ sessionId, message: content, channel: "web" }),
          headers,
        },
      )

      // Adopt server-issued credentials BEFORE opening the stream. The POST may
      // have RE-MINTED the guest secret (server-side first-request branch), and
      // the stream is a SEPARATE request that must present the CURRENT one.
      if (res.sessionSecret) setSessionSecret(res.sessionSecret)
      if (res.sessionToken) setSessionToken(res.sessionToken)

      addMessage(buildAssistantPlaceholder())

      // BKL-286: read the credentials back out of the store AFTER adoption, so
      // the stream is authenticated with whatever this turn's POST just
      // established rather than with the value captured before it. Headers (not
      // a query param) because this is a fetch-based SSE reader, not an
      // EventSource — a URL would leak the secret into access/proxy logs.
      const { sessionSecret: streamSecret, sessionToken: streamToken } = useChatStore.getState()
      const streamHeaders: Record<string, string> = {}
      if (streamSecret) streamHeaders["x-session-secret"] = streamSecret
      if (streamToken) streamHeaders["x-session-token"] = streamToken

      let terminated = false
      await apiStream(
        `/api/chat/stream/${sessionId}`,
        (raw: unknown) => {
          if (!isStreamChunk(raw)) return
          switch (raw.type) {
            case 'text_delta':
              updateLastMessage(raw.delta)
              break
            case 'error':
              // Never echo the frame: map it to vetted pt-BR copy (leg 2).
              setErrorView(describeChatError(raw))
              terminated = true
              setLoading(false)
              break
            case 'done':
              terminated = true
              setLoading(false)
              break
          }
        },
        undefined,
        streamHeaders,
      )

      // A denied stream ends after its `error` frame and never sends `done`;
      // a dropped connection may send neither. Either way the widget must not
      // be left spinning with its input disabled forever.
      if (!terminated) {
        setErrorView(describeChatError())
        setLoading(false)
      }
    } catch (err) {
      // The thrown value is never shown: transport errors carry technical,
      // non-pt-BR text ("API error: 403 Forbidden") that must not reach a
      // customer. Only its STATUS is read, to pick the right vetted copy.
      setErrorView(describeChatError(err instanceof ApiError ? { status: err.status } : undefined))
      setLoading(false)
    }
  }

  return { sendMessage, startNewConversation }
}
