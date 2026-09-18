import nodeProcess from 'node:process'
import { MIGRATIONS_DIRECTORY } from '@qtaxis/sdk'
import { Client } from 'pg'
import { APP_MIGRATIONS_DIRECTORY, applyPending, ensureDatabase } from '../db/migrate.js'
import { readConfig } from '../config.js'
import { log } from '../log.js'

async function main(): Promise<void> {
  const config = readConfig()
  await ensureDatabase(config.databaseUrl)

  const client = new Client({ connectionString: config.databaseUrl })
  await client.connect()
  try {
    const applied = await applyPending(client, [MIGRATIONS_DIRECTORY, APP_MIGRATIONS_DIRECTORY])
    for (const file of applied) {
      log('migrate', 'applied', { file })
    }
    log('migrate', 'done', { count: applied.length })
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  log('migrate', 'failed', { message })
  nodeProcess.exitCode = 1
})
