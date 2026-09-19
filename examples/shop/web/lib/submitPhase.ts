export type SubmitPhase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done' }
  | { kind: 'failed'; error: string }

export type SubmitEvent = { kind: 'submit' } | { kind: 'succeeded' } | { kind: 'failed'; error: string }

/** True when a submit should actually start a request: not already submitting, and not settled done. Shared by every call site instead of an imperative ref check, so a second press or an implicit Enter-key submit cannot fire twice. */
export function canSubmit(phase: SubmitPhase): boolean {
  return phase.kind !== 'submitting' && phase.kind !== 'done'
}

// idle -> submitting -> done | failed. A further submit once done is
// ignored: the action already committed (the row is leaving the list, the
// command is already sent) and there is nothing left to repeat it for. A
// failed submit allows a retry. Shared by ShipForm and the resend-invoice
// action — same shape, same rules.
export function nextSubmitPhase(phase: SubmitPhase, event: SubmitEvent): SubmitPhase {
  if (event.kind === 'submit') return canSubmit(phase) ? { kind: 'submitting' } : phase
  if (event.kind === 'succeeded') return { kind: 'done' }
  return { kind: 'failed', error: event.error }
}
