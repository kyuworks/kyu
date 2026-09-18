import http from 'node:http'
import nodeProcess from 'node:process'
import type { Pool } from 'pg'
import { readConfig } from './config.js'
import { createPool } from './db/pool.js'
import { createPlaygroundKinesin } from './kinesin.js'
import { describeError, exitAfterLog, log } from './log.js'
import { handleUiRequest } from './ui/handleRequest.js'

// The engine's own dashboard, not one Kinesin ships (see infra/hatchet/compose.yaml).
const DASHBOARD_URL = 'http://localhost:8888'

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function shutdown(server: http.Server, pool: Pool): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  })
  await pool.end()
  nodeProcess.exit(0)
}

function onShutdownSignal(server: http.Server, pool: Pool): void {
  shutdown(server, pool).catch((error) => {
    exitAfterLog(1, 'ui', 'shutdown-failed', { message: describeError(error) })
  })
}

async function main(): Promise<void> {
  const config = readConfig()
  const pool = createPool(config.databaseUrl)
  const kinesin = createPlaygroundKinesin(config)

  const server = http.createServer((req, res) => {
    readBody(req)
      .then((body) =>
        handleUiRequest(
          { pool, kinesin, dashboardUrl: DASHBOARD_URL },
          { method: req.method ?? '', url: req.url ?? '', body },
        ),
      )
      .then((response) => {
        res.writeHead(response.status, { 'content-type': response.contentType })
        res.end(response.body)
      })
      .catch((error) => {
        log('ui', 'failed', { message: describeError(error) })
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: describeError(error) }))
      })
  })

  nodeProcess.on('SIGTERM', () => onShutdownSignal(server, pool))
  nodeProcess.on('SIGINT', () => onShutdownSignal(server, pool))

  server.listen(config.uiPort, '127.0.0.1', () => {
    log('ui', 'ready', { port: config.uiPort, url: `http://127.0.0.1:${config.uiPort}` })
  })
}

main().catch((error) => {
  exitAfterLog(1, 'ui', 'failed', { message: describeError(error) })
})
