import nodeProcess from 'node:process'

export interface LogFields {
  [key: string]: string | number | boolean | null
}

// The three processes each print a `ready` line the driver waits on; NDJSON
// keeps that contract dependency-free.
export function log(process: string, event: string, fields?: LogFields): void {
  const record = { ts: new Date().toISOString(), process, event, ...fields }
  nodeProcess.stdout.write(`${JSON.stringify(record)}\n`)
}
