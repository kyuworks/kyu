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
import { z } from 'zod'

// server.address() returns AddressInfo | string | null; the string case is
// a unix socket path, which never applies here since every server below
// binds a TCP port with an explicit host and port 0. Parsed, not cast or
// typeof-narrowed (oxlint-rules/anti-slop's no-runtime-typeof bans typeof
// outright in this package) — the same "decode at the boundary" idiom this
// file's siblings use for a pg row.
const addressInfoSchema = z.object({ address: z.string(), family: z.string(), port: z.number() })

interface ForwardTarget {
  server: net.Server
  sockets: Set<net.Socket>
  cutFlag: { cut: boolean }
}

function startForward(targetHost: string, targetPort: number): ForwardTarget {
  const sockets = new Set<net.Socket>()
  const cutFlag = { cut: false }
  const server = net.createServer((incoming) => {
    if (cutFlag.cut) {
      incoming.destroy()
      return
    }
    const outgoing = net.connect(targetPort, targetHost)
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
  /** Destroys every open connection and refuses new ones — simulates the engine going unreachable. */
  cut(): void
  /** Resumes forwarding; already-open connections were destroyed by cut(), so callers reconnect on their own retry. */
  open(): void
  close(): Promise<void>
}

export interface StartEngineProxyOptions {
  targetHost?: string
  grpcTargetPort?: number
  apiTargetPort?: number
}

/** Starts both forwarding servers on ephemeral ports and waits for both to bind. */
export async function startEngineProxy(options: StartEngineProxyOptions = {}): Promise<EngineProxy> {
  const targetHost = options.targetHost ?? '127.0.0.1'
  const grpc = startForward(targetHost, options.grpcTargetPort ?? 7077)
  const api = startForward(targetHost, options.apiTargetPort ?? 8888)

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
