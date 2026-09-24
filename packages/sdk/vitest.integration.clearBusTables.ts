import { Client } from 'pg'
import { beforeAll } from 'vitest'

// Runs once per integration file, before the file's own hooks. Vitest orders
// files by size, so a file that leaves rows behind lands on a different
// neighbour in CI than it does locally: no file may decide what the next
// file's first test sees.
beforeAll(async () => {
  const connectionString = process.env['KYU_TEST_DATABASE_URL']
  if (!connectionString) {
    throw new Error(
      [
        'KYU_TEST_DATABASE_URL is not set, so the integration suite cannot empty the bus tables for this file.',
        'Point it at the Postgres the local engine stack exposes:',
        '  export KYU_TEST_DATABASE_URL="postgresql://hatchet:hatchet@localhost:15432/kyu_test"',
      ].join('\n'),
    )
  }
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query('TRUNCATE kyu_outbox, kyu_processed, kyu_paused_tenant')
  } finally {
    await client.end()
  }
})
