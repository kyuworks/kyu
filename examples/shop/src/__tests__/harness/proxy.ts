// A harness-owned TCP proxy in front of the local engine's two ports (7077
// gRPC, 8888 REST). The engine outage scenario simulates the engine being
// unreachable by cutting this, never by touching Docker: proven against the
// running local engine (plan-144.md's proxy-proof.sh and
// worker-proxy-proof.sh) that a plain byte passthrough on both ports is
// enough for the SDK's own HATCHET_CLIENT_HOST_PORT / HATCHET_CLIENT_API_URL
// overrides (config-loader.js) to route relay and worker traffic through it.
// runs.cancel and runs.list are REST on 8888, not gRPC (v1/client/features/
// runs.js), so a proxy that only fronted 7077 would leave cancellation
// working during a simulated outage — this one fronts both.
import net from 'node:net'
import tls from 'node:tls'
import { z } from 'zod'

// server.address() returns AddressInfo | string | null; the string case is
// a unix socket path, which never applies here since every server below
// binds a TCP port with an explicit host and port 0. Parsed, not cast or
// typeof-narrowed (oxlint-rules/anti-slop's no-runtime-typeof bans typeof
// outright in this package) — the same "decode at the boundary" idiom this
// file's siblings use for a pg row.
const addressInfoSchema = z.object({ address: z.string(), family: z.string(), port: z.number() })

/** One TLS-or-plain forwarding leg, resolved once from env at the trust edge. */
interface EngineProxyLeg {
  host: string
  port: number
  tls: boolean
  servername?: string
}

/** The two engine ports to proxy, resolved once from the client env — nothing below this reads process.env. */
export interface EngineProxyTarget {
  grpcHost: string
  grpcPort: number
  apiHost: string
  apiPort: number
  apiTls: boolean
  servername?: string
}

const hostPortSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
})

function parseHostPort(hostPort: string): { host: string; port: number } {
  const lastColon = hostPort.lastIndexOf(':')
  if (lastColon === -1) throw new Error(`expected host:port, got ${hostPort}`)
  // A bare (unbracketed) IPv6 literal has more than one colon, which makes
  // the split on the last colon ambiguous; bracket it (e.g. [::1]:7077).
  if (!hostPort.startsWith('[') && hostPort.indexOf(':') !== lastColon) {
    throw new Error(`ambiguous host:port for a bare IPv6 literal, bracket the host: ${hostPort}`)
  }
  return hostPortSchema.parse({ host: hostPort.slice(0, lastColon), port: hostPort.slice(lastColon + 1) })
}

const DOTTED_QUAD = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** grpc-js's ssl_target_name_override only makes sense pointed at the real remote name. */
function servernameFor(host: string): string | undefined {
  return host === 'localhost' || DOTTED_QUAD.test(host) ? undefined : host
}

/** Decoded once, at the trust edge: everything below takes this parsed target, never process.env again. */
export function engineProxyTargetFromEnv(env: NodeJS.ProcessEnv): EngineProxyTarget {
  const grpc = parseHostPort(env['HATCHET_CLIENT_HOST_PORT'] ?? '127.0.0.1:7077')
  const apiUrlString = env['HATCHET_CLIENT_API_URL'] ?? 'http://127.0.0.1:8888'
  const apiUrl = new URL(z.url().parse(apiUrlString))
  const apiTls = apiUrl.protocol === 'https:'
  const apiPort = apiUrl.port !== '' ? Number(apiUrl.port) : apiTls ? 443 : 80
  const servername = servernameFor(grpc.host)

  const target: EngineProxyTarget = {
    grpcHost: grpc.host,
    grpcPort: grpc.port,
    apiHost: apiUrl.hostname,
    apiPort,
    apiTls,
  }
  if (servername !== undefined) target.servername = servername
  return target
}

interface ForwardTarget {
  server: net.Server
  sockets: Set<net.Socket>
  cutFlag: { cut: boolean }
}

// The gRPC leg is a plain byte passthrough: grpc-js's ssl_target_name_override
// sets the SNI and the certificate identity check, so a proxied TCP stream to
// the real TLS edge still validates. The API leg cannot do that — plain HTTP
// to a TLS-only port never completes a handshake — so it originates its own
// TLS connection to the target when the leg says so.
function startForward(leg: EngineProxyLeg): ForwardTarget {
  const sockets = new Set<net.Socket>()
  const cutFlag = { cut: false }
  const server = net.createServer((incoming) => {
    if (cutFlag.cut) {
      incoming.destroy()
      return
    }
    const outgoing = leg.tls
      ? tls.connect({ host: leg.host, port: leg.port, servername: leg.servername ?? leg.host })
      : net.connect(leg.port, leg.host)
    sockets.add(incoming)
    sockets.add(outgoing)
    incoming.pipe(outgoing)
    outgoing.pipe(incoming)
    const cleanup = (): void => {
      sockets.delete(incoming)
      sockets.delete(outgoing)
      incoming.destroy()
      outgoing.destroy()
    }
    incoming.on('error', cleanup)
    outgoing.on('error', cleanup)
    incoming.on('close', cleanup)
    outgoing.on('close', cleanup)
  })
  return { server, sockets, cutFlag }
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const parsed = addressInfoSchema.safeParse(server.address())
      if (!parsed.success) {
        reject(new Error('proxy server did not bind to a TCP port'))
        return
      }
      resolve(parsed.data.port)
    })
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

export interface EngineProxy {
  /** 127.0.0.1:<port> — pass as HATCHET_CLIENT_HOST_PORT. */
  grpcHostPort: string
  /** http://127.0.0.1:<port> — pass as HATCHET_CLIENT_API_URL. */
  apiUrl: string
  /** The resolved target this proxy cuts — the real engine host, not the local listen address. */
  target: EngineProxyTarget
  /** Destroys every open connection and refuses new ones — simulates the engine going unreachable. */
  cut(): void
  /** Resumes forwarding; already-open connections were destroyed by cut(), so callers reconnect on their own retry. */
  open(): void
  close(): Promise<void>
}

export interface StartEngineProxyOptions {
  target?: EngineProxyTarget
}

/** Starts both forwarding servers on ephemeral ports and waits for both to bind. */
export async function startEngineProxy(options: StartEngineProxyOptions = {}): Promise<EngineProxy> {
  const target = options.target ?? engineProxyTargetFromEnv(process.env)
  const grpc = startForward({ host: target.grpcHost, port: target.grpcPort, tls: false })
  const apiLeg: EngineProxyLeg = { host: target.apiHost, port: target.apiPort, tls: target.apiTls }
  if (target.servername !== undefined) apiLeg.servername = target.servername
  const api = startForward(apiLeg)

  const [grpcPort, apiPort] = await Promise.all([listen(grpc.server), listen(api.server)])

  const cutBoth = (): void => {
    grpc.cutFlag.cut = true
    api.cutFlag.cut = true
    for (const socket of grpc.sockets) socket.destroy()
    for (const socket of api.sockets) socket.destroy()
  }

  return {
    grpcHostPort: `127.0.0.1:${String(grpcPort)}`,
    apiUrl: `http://127.0.0.1:${String(apiPort)}`,
    target,
    cut: cutBoth,
    open: () => {
      grpc.cutFlag.cut = false
      api.cutFlag.cut = false
    },
    close: async () => {
      cutBoth()
      await Promise.all([closeServer(grpc.server), closeServer(api.server)])
    },
  }
}
