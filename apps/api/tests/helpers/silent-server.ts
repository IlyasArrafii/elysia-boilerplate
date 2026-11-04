import { createServer, type AddressInfo, type Socket } from 'node:net'

export interface SilentServer {
  port: number
  // Connections accepted so far.
  connections(): number
  stop(): Promise<void>
}

// Accepts TCP connections and never answers, like a stalled PostgreSQL or MongoDB: the client
// connects, sends its handshake and waits for a reply that never comes.
export async function createSilentServer(): Promise<SilentServer> {
  const sockets = new Set<Socket>()
  let accepted = 0
  const server = createServer((socket) => {
    accepted++
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => accepted,
    stop: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

// A port nothing listens on once this returns, for a server the test starts itself.
export function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
  const { port } = probe
  void probe.stop(true)
  if (port === undefined) throw new Error('Bun.serve did not report a port')
  return port
}
