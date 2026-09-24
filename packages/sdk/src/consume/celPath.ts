import { KyuError } from '../errors.js'

// A dotted identifier path only: the field is spliced straight into a CEL
// expression, so anything else is an injection vector.
const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

/** `input.<field>` for a dotted path relative to the payload, such as `data.orderId`; `label` names the option in the error. */
export function celPayloadPath(label: string, field: string): string {
  if (!FIELD_PATH_PATTERN.test(field)) {
    throw new KyuError(`${label} "${field}" is not a dotted identifier path`)
  }
  // A leading "input." would splice into `input.input....`, a silent never-match.
  if (field === 'input' || field.startsWith('input.')) {
    throw new KyuError(`${label} "${field}" is relative to the payload; drop the leading "input."`)
  }
  return `input.${field}`
}
