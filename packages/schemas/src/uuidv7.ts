import { randomFillSync } from 'node:crypto'

// 48-bit ms timestamp, version nibble 7, variant bits 10. A 12-bit counter
// in rand_a keeps same-millisecond ids lexically increasing; on overflow the
// timestamp is bumped by a synthetic millisecond rather than reusing a value.
// rand_b stays fully random.
const RAND_A_COUNTER_MASK = 0xfffn

interface CounterTick {
  timestampMs: number
  counter: bigint
}

let lastTimestampMs = -1
let counter = 0n

function nextTick(now: number): CounterTick {
  if (now > lastTimestampMs) {
    lastTimestampMs = now
    counter = 0n
    return { timestampMs: lastTimestampMs, counter }
  }
  counter += 1n
  if (counter > RAND_A_COUNTER_MASK) {
    lastTimestampMs += 1
    counter = 0n
  }
  return { timestampMs: lastTimestampMs, counter }
}

function randomRandB(): bigint {
  const bytes = randomFillSync(new Uint8Array(8))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const high = BigInt(view.getUint32(0, false))
  const low = BigInt(view.getUint32(4, false))
  return ((high << 32n) | low) & ((1n << 62n) - 1n)
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function uuidv7(now = Date.now()): string {
  const { timestampMs, counter: randA } = nextTick(now)
  const ts = BigInt(timestampMs)
  const randB = randomRandB()

  const bytes = new Uint8Array(16)
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)
  bytes[6] = 0x70 | Number((randA >> 8n) & 0x0fn)
  bytes[7] = Number(randA & 0xffn)
  bytes[8] = 0x80 | Number((randB >> 56n) & 0x3fn)
  bytes[9] = Number((randB >> 48n) & 0xffn)
  bytes[10] = Number((randB >> 40n) & 0xffn)
  bytes[11] = Number((randB >> 32n) & 0xffn)
  bytes[12] = Number((randB >> 24n) & 0xffn)
  bytes[13] = Number((randB >> 16n) & 0xffn)
  bytes[14] = Number((randB >> 8n) & 0xffn)
  bytes[15] = Number(randB & 0xffn)

  return formatUuid(bytes)
}
