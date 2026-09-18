import http from 'node:http'
import nodeProcess from 'node:process'
import type { Pool } from 'pg'
import { readConfig } from './config.js'
import { createPool } from './db/pool.js'
import { createPlaygroundQtaxis } from './qtaxis.js'
import { describeError, exitAfterLog, log } from './log.js'
import { buildSubscriptions } from './subscriptions.js'
import { describeBusTopology } from './ui/busTopology.js'
import { handleUiRequest } from './ui/handleRequest.js'

// The engine's own dashboard, not one Qtaxis ships (see infra/hatchet/compose.yaml).
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
  const qtaxis = createPlaygroundQtaxis(config)
  // Built once from the same registry the worker uses, so the diagram at
  // /bus can never name a subscription the worker does not run.
  const topology = describeBusTopology(buildSubscriptions(qtaxis, pool, config))

  const server = http.createServer((req, res) => {
    readBody(req)
      .then((body) =>
        handleUiRequest(
          { pool, qtaxis, dashboardUrl: DASHBOARD_URL, topology },
          { method: req.method ?? '', url: req.url ?? '', contentType: req.headers['content-type'] ?? '', body },
        ),
      )
      .then((response) => {
        // /bus.json is read every 2s; without this an intermediary could cache a stale count.
        if (response.contentType === 'application/json') {
          res.writeHead(response.status, { 'content-type': response.contentType, 'cache-control': 'no-store' })
        } else {
          res.writeHead(response.status, { 'content-type': response.contentType })
        }
        res.end(response.body)
      })
      .catch((error) => {
        log('ui', 'failed', { message: describeError(error) })
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: describeError(error) }))
      })
  })

  // A port already in use (or another bind failure) fires here, not as a
  // thrown exception; without this the process would print a raw stack
  // trace instead of the NDJSON line a supervisor watches for.
  server.on('error', (error) => {
    exitAfterLog(1, 'ui', 'listen-failed', { message: describeError(error) })
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
