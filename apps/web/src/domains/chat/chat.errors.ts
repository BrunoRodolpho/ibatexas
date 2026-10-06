/**
 * BKL-286 leg 2 — customer-facing chat error copy.
 *
 * INVARIANT: everything the chat surface shows on a failure comes from THIS
 * module. Nothing else may reach the customer — not a server string, not an
 * `Error.message`, and above all not a response payload. The chat once printed
 * the raw POST JSON into a message bubble; the structural guarantee against a
 * repeat is that the UI renders only these constants, chosen by
 * {@link describeChatError}, which returns copy for EVERY input it is given.
 *
 * pt-BR only (Hard Rule #4).
 */

/** A rendered chat failure: human copy plus the recovery the UI should offer. */
export interface ChatErrorView {
  /** Customer-facing pt-BR sentence. Never a payload, code or server string. */
  message: string
  /** Offer the "start a new conversation" affordance alongside the message. */
  canRestart: boolean
}

/**
 * Machine-readable reason on an SSE `error` frame. The wire carries this
 * ALONGSIDE its prose so the client never has to string-match pt-BR copy
 * (which would silently break the moment the server rewords a sentence).
 */
export const CHAT_ERROR_CODE_SESSION_DENIED = 'session_denied'

/** The session credential no longer matches — only a fresh session recovers. */
export const CHAT_SESSION_EXPIRED_PTBR =
  'Sua conversa anterior expirou. Inicie uma nova conversa para continuar falando com a gente.'

/** Anything else: transient, retryable, no session surgery needed. */
export const CHAT_GENERIC_FAILURE_PTBR =
  'Não consegui enviar sua mensagem agora. Tente novamente em instantes.'

/** Copy for the start-over affordance. */
export const CHAT_RESTART_LABEL_PTBR = 'Iniciar nova conversa'

const SESSION_EXPIRED_VIEW: ChatErrorView = {
  message: CHAT_SESSION_EXPIRED_PTBR,
  canRestart: true,
}

const GENERIC_VIEW: ChatErrorView = {
  message: CHAT_GENERIC_FAILURE_PTBR,
  canRestart: false,
}

/**
 * The pt-BR denial prose the API writes today. Matched only as a FALLBACK for a
 * server that predates the `code` field — the code is the real discriminator.
 */
const LEGACY_DENIAL_PROSE = 'Acesso negado.'

/**
 * PURE. Map a transport failure to customer-facing copy.
 *
 * Total by construction: every input — including an object, an array, `null`,
 * or a raw response body that somehow reached this seam — yields one of the
 * constants above. There is no branch that echoes the input back, which is what
 * makes "no raw payload can render" a property of the code rather than a habit.
 */
export function describeChatError(input?: {
  code?: unknown
  message?: unknown
  /** HTTP status when the failure was a rejected request rather than a frame. */
  status?: unknown
}): ChatErrorView {
  if (input?.code === CHAT_ERROR_CODE_SESSION_DENIED) return SESSION_EXPIRED_VIEW

  // A rejected POST: the browser holds a credential the server will not accept.
  // The tab-scoped secret dies with the tab while the server keeps its copy for
  // an hour, so a returning visitor lands here — and only a NEW conversation
  // recovers, exactly as for a denied stream.
  if (input?.status === 403) return SESSION_EXPIRED_VIEW

  // Legacy servers send the denial as prose with no code.
  if (typeof input?.message === 'string' && input.message.trim() === LEGACY_DENIAL_PROSE) {
    return SESSION_EXPIRED_VIEW
  }

  return GENERIC_VIEW
}
