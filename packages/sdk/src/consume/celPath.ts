import { KyuError, WaitArgumentRejectedError } from '../errors.js'

// A dotted identifier path only: the field is spliced straight into a CEL
// expression, so anything else is an injection vector.
const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

function celPathRefusal(label: string, field: string): string | undefined {
  if (!FIELD_PATH_PATTERN.test(field)) return `${label} "${field}" is not a dotted identifier path`
  // A leading "input." would splice into `input.input....`, a silent never-match.
  if (field === 'input' || field.startsWith('input.')) {
    return `${label} "${field}" is relative to the payload; drop the leading "input."`
  }
  return undefined
}

/** `input.<field>` for a dotted path relative to the payload, such as `data.orderId`, checked when the worker registers; a KyuError names `label`. */
export function celPayloadPath(label: string, field: string): string {
  const refusal = celPathRefusal(label, field)
  if (refusal !== undefined) throw new KyuError(refusal)
  return `input.${field}`
}

/** The same path for a wait's `where.field` inside a running durable body; a WaitArgumentRejectedError fails the run at once. */
export function celWaitPayloadPath(label: string, field: string): string {
  const refusal = celPathRefusal(label, field)
  if (refusal !== undefined) throw new WaitArgumentRejectedError(refusal)
  return `input.${field}`
}
