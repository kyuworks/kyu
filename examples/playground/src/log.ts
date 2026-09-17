export interface LogFields {
  [key: string]: string | number | boolean | null
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
