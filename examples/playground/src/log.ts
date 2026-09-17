export interface LogFields {
  [key: string]: string | number | boolean | null
}

// The three processes each print a `ready` line the driver waits on; NDJSON
// keeps that contract dependency-free. ts is set first and reapplied last so
// a caller-supplied field of the same name can never win or move it.
export function log(proc: string, event: string, fields?: LogFields): void {
  const ts = new Date().toISOString()
  const record: LogFields = { ts }
  Object.assign(record, fields)
  record['ts'] = ts
  record['process'] = proc
  record['event'] = event
  process.stdout.write(`${JSON.stringify(record)}\n`)
}
