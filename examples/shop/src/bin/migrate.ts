import nodeProcess from 'node:process'
import { MIGRATIONS_DIRECTORY } from '@kyuworks/sdk'
import { Client } from 'pg'
import { APP_MIGRATIONS_DIRECTORY, applyPending, ensureDatabase, migrateLogFields } from '../db/migrate.js'
import { readConfig } from '../config.js'
import { log } from '../log.js'

async function main(): Promise<void> {
  const config = readConfig()
  // Never the connection string: a wrong database name in a deployed
  // secret must be diagnosable from this line alone (issue #166).
  const fields = migrateLogFields(config.databaseUrl)
  try {
    log('migrate', 'start', fields)
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('migrate', 'failed', { message, ...fields })
    nodeProcess.exitCode = 1
  }
}

main().catch((error) => {
  // Only reachable if readConfig()/migrateLogFields() itself threw, before
  // a database name was ever available to log.
  const message = error instanceof Error ? error.message : String(error)
  log('migrate', 'failed', { message })
  nodeProcess.exitCode = 1
})
