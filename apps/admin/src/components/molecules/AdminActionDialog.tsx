'use client'

import { useState } from 'react'
import { Modal, Button } from '@ibatexas/ui'

/**
 * OPS-071 — shared confirm-step dialog for the two-phase destructive admin
 * actions (force-cancel, refund, waive, force payment status).
 *
 * The backend two-person protocol works like this: step 1 (`POST <path>`)
 * either executes directly (200) or, for a destructive/above-threshold op,
 * parks a receipt and returns 202 `{ confirmationId, prompt, ttlSeconds }`;
 * step 2 (`POST <path>/confirm` with `{ confirmationId }`) must be issued by a
 * DIFFERENT staff member (server-side same-actor refusal, 403).
 *
 * This dialog drives both phases:
 *   - `collect`  — gather the step-1 inputs (reason, optional refund amount).
 *   - `confirm`  — surface the server's pt-BR prompt and fire step 2.
 *
 * It is presentation-only: it owns its transient input state and hands the
 * values back through callbacks; the page owns the HTTP calls.
 */
export interface AdminActionDialogProps {
  readonly open: boolean
  readonly phase: 'collect' | 'confirm'
  readonly title: string
  /** Step-1 reason is required (waive / force-status) vs optional (force-cancel / refund). */
  readonly reasonRequired: boolean
  /** Show the optional refund-amount field (refund only). */
  readonly withAmount: boolean
  /** Server 202 prompt, shown in the confirm phase. */
  readonly prompt: string
  /** True while a step-1 or step-2 request is in flight. */
  readonly loading: boolean
  /** Fire step 1 with the collected reason + (for refund) amount in reais as typed. */
  readonly onSubmitCollect: (reason: string, amountReais: string) => void
  /** Fire step 2 (the second-operator confirmation). */
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function AdminActionDialog({
  open,
  phase,
  title,
  reasonRequired,
  withAmount,
  prompt,
  loading,
  onSubmitCollect,
  onConfirm,
  onCancel,
}: AdminActionDialogProps): React.JSX.Element {
  // Inputs are transient to a single action. The parent remounts this dialog
  // (via a changing `key`) each time a new action opens, so state starts fresh
  // — no reset effect needed.
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState('')

  const canSubmit = !reasonRequired || reason.trim().length > 0

  const footer =
    phase === 'collect' ? (
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={loading}>
          Cancelar
        </Button>
        <Button
          variant="primary"
          size="sm"
          isLoading={loading}
          disabled={!canSubmit}
          onClick={() => onSubmitCollect(reason.trim(), amount.trim())}
        >
          Continuar
        </Button>
      </div>
    ) : (
      <div className="flex gap-2 justify-end">
        <Button variant="secondary" size="sm" onClick={onCancel} disabled={loading}>
          Cancelar
        </Button>
        <Button variant="danger" size="sm" isLoading={loading} onClick={onConfirm}>
          Confirmar
        </Button>
      </div>
    )

  return (
    <Modal isOpen={open} onClose={onCancel} title={title} footer={footer} size="sm">
      {phase === 'collect' ? (
        <div className="flex flex-col gap-3">
          {withAmount && (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-charcoal-700">Valor do reembolso (R$) — em branco reembolsa o total</span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Ex.: 50,00"
                className="rounded-sm border border-smoke-200 px-2 py-1 text-charcoal-900"
              />
            </label>
          )}
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-charcoal-700">Motivo{reasonRequired ? ' (obrigatório)' : ' (opcional)'}</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              className="rounded-sm border border-smoke-200 px-2 py-1 text-charcoal-900"
            />
          </label>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-charcoal-700">{prompt}</p>
          <p className="text-xs text-charcoal-700">
            Esta confirmação exige um segundo operador (regra de dupla checagem): quem iniciou a ação não pode
            confirmá-la.
          </p>
        </div>
      )}
    </Modal>
  )
}
