// Shared domain service helpers.

/**
 * Assert that the requesting customer owns the entity.
 * Throws with a user-facing pt-BR message on mismatch.
 */
export function assertOwnership(
  entityCustomerId: string,
  requestCustomerId: string,
  entityLabel = "este recurso",
): void {
  if (entityCustomerId !== requestCustomerId) {
    throw new Error(`Você não tem permissão para acessar ${entityLabel}.`)
  }
}

/** Status values that indicate a reservation is terminal (no further mutations). */
const TERMINAL_STATUSES = ["cancelled", "no_show", "completed"] as const

/**
 * Assert that a reservation is in a mutable state.
 * Throws if the status is cancelled, no_show, or completed.
 */
export function assertMutable(status: string, action = "modificar"): void {
  if ((TERMINAL_STATUSES as readonly string[]).includes(status)) {
    throw new Error(
      `Não é possível ${action} uma reserva com status "${status}".`,
    )
  }
}
