// 48-bit ms timestamp, version nibble 7, variant bits 10. A 12-bit rand_a counter keeps
// same-millisecond ids increasing; overflow bumps a synthetic millisecond. rand_b is random.
const RAND_A_COUNTER_MASK = 0xfffn

let lastTimestampMs = -1
let counter = 0n

// Advances the module's clock/counter state; callers read `lastTimestampMs` and `counter` after.
function tick(now: number): void {
  if (now > lastTimestampMs) {
    lastTimestampMs = now
    counter = 0n
    return
  }
  counter += 1n
  if (counter > RAND_A_COUNTER_MASK) {
    lastTimestampMs += 1
    counter = 0n
  }
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function uuidv7(): string {
  tick(Math.floor(Date.now()))
  const ts = BigInt(lastTimestampMs)
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))

  for (let shift = 0; shift < 6; shift += 1) bytes[shift] = Number((ts >> BigInt(40 - shift * 8)) & 0xffn)
  bytes[6] = 0x70 | Number((counter >> 8n) & 0x0fn)
  bytes[7] = Number(counter & 0xffn)
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)

  return formatUuid(bytes)
}
