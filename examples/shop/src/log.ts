import { KyuError } from '@kyuworks/sdk'

export interface LogFields {
  [key: string]: string | number | boolean | null
}

// pg raises an AggregateError with an empty top-level message on a refused
// connection; join its constituent errors instead of logging a blank reason.
// A KyuError's own message names the call that failed (runOutcomes.ts's
// readRunOutcomesFor: "runs.forEnvelope: could not read runs for ..."); its
// `cause` names why, and is dropped without this — a scenario failure would
// otherwise say only that a read failed, never why.
export function describeError(cause: unknown): string {
  if (cause instanceof AggregateError) return cause.errors.map(describeError).join(', ')
  if (cause instanceof KyuError && cause.cause instanceof Error) {
    return `${cause.message}: ${describeError(cause.cause)}`
  }
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message
  return String(cause)
}

// ts is set first and reapplied last so a caller-supplied field of the same
// name can never win or move it.
function formatLine(proc: string, event: string, fields?: LogFields): string {
  const ts = new Date().toISOString()
  const record: LogFields = { ts }
  Object.assign(record, fields)
  record['ts'] = ts
  record['process'] = proc
  record['event'] = event
  return `${JSON.stringify(record)}\n`
}

// The three processes each print a `ready` line the driver waits on; NDJSON
// keeps that contract dependency-free.
export function log(proc: string, event: string, fields?: LogFields): void {
  process.stdout.write(formatLine(proc, event, fields))
}

// process.exit() right after a bare write can truncate the line on a pipe;
// wait for the write's own callback so the last log line always lands.
export function exitAfterLog(code: number, proc: string, event: string, fields?: LogFields): void {
  process.stdout.write(formatLine(proc, event, fields), () => process.exit(code))
}
