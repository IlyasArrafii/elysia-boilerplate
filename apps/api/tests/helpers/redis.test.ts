import { describe, expect, test } from 'bun:test'
import type { Socket } from 'bun'
import { createReplyDroppingProxy, createStallingRedis, flush, type ReplyDroppingProxy, send } from './redis'
import { createSilentServer } from './silent-server'

describe('createReplyDroppingProxy URL', () => {
  // [target, the proxy's URL with <port> for its own port]. Nothing connects until a client does.
  test.each([
    ['redis://127.0.0.1:6389', 'redis://127.0.0.1:<port>'],
    ['redis://:s%40cret@127.0.0.1:6389', 'redis://:s%40cret@127.0.0.1:<port>'],
    ['redis://app%40api:p%3Aw%2Fd%23@127.0.0.1:6389/2', 'redis://app%40api:p%3Aw%2Fd%23@127.0.0.1:<port>/2'],
    // The proxy speaks TLS to the target and plain RESP to the client.
    ['rediss://admin:pw@cache.example.test:6380', 'redis://admin:pw@127.0.0.1:<port>'],
  ])('%s is proxied as %s', (target, expected) => {
    const proxy = createReplyDroppingProxy(target)
    try {
      expect(proxy.url).toBe(expected.replace('<port>', new URL(proxy.url).port))
    } finally {
      proxy.stop()
    }
  })

  test('a target it would not reach as the client does is refused up front', () => {
    expect(() => createReplyDroppingProxy('redis+tls://127.0.0.1:6380')).toThrow(
      'takes redis:// or rediss:// targets, not redis+tls://',
    )
  })
})

const encoder = new TextEncoder()

interface RawClient {
  socket: Socket
  // Writes with backpressure as the proxy does: what one socket.write does not take is written on
  // `drain`, in order.
  write(text: string): void
  replies(): string
}

// A raw client, to control exactly which bytes reach the proxy in which chunk.
async function rawClient(proxy: ReplyDroppingProxy): Promise<RawClient> {
  const decoder = new TextDecoder()
  const pending: Uint8Array[] = []
  let replies = ''
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: Number(new URL(proxy.url).port),
    socket: {
      data(_socket, data) {
        replies += decoder.decode(data)
      },
      drain(socket) {
        flush(socket, pending)
      },
    },
  })
  return { socket, write: (text) => send(socket, pending, encoder.encode(text)), replies: () => replies }
}

const PING = '*1\r\n$4\r\nPING\r\n'

describe('createReplyDroppingProxy commands', () => {
  test('a command split across chunks is recorded and passed on once whole, pipelined ones each once', async () => {
    const server = createStallingRedis()
    const proxy = createReplyDroppingProxy(server.url)
    const client = await rawClient(proxy)
    try {
      // Every cut lands inside a command: in the `*` line, the name, between CR and LF.
      client.write('*1\r\n$4\r\nPI')
      await Bun.sleep(50)
      expect(proxy.commands()).toEqual([])
      expect(client.replies()).toBe('')

      client.write(`NG\r\n${PING}*1\r`)
      await Bun.sleep(50)
      expect(proxy.commands()).toEqual(['PING', 'PING'])

      client.write('\n$4\r\nping\r\n')
      await Bun.sleep(50)
      expect(proxy.commands()).toEqual(['PING', 'PING', 'PING'])
      expect(client.replies()).toBe('+PONG\r\n'.repeat(3))
    } finally {
      client.socket.end()
      proxy.stop()
      server.stop()
    }
  })

  // A parser that split on CRLF would read the value as two more commands.
  test('values are skipped by their byte length, so CRLF and multi-byte text inside one is not a command', async () => {
    const server = await createSilentServer()
    const proxy = createReplyDroppingProxy(`redis://127.0.0.1:${server.port}`)
    const client = await rawClient(proxy)
    const value = `é\r\n${PING}${PING}`
    try {
      client.write(`*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$${Buffer.byteLength(value)}\r\n${value}\r\n${PING}`)
      await Bun.sleep(50)

      expect(proxy.commands()).toEqual(['SET', 'PING'])
    } finally {
      client.socket.end()
      proxy.stop()
      await server.stop()
    }
  })

  test('a refused command is answered with NOPERM and only the others reach the server', async () => {
    const server = createStallingRedis()
    const proxy = createReplyDroppingProxy(server.url)
    const client = await rawClient(proxy)
    try {
      proxy.refuse('ping')
      client.write(PING)
      await Bun.sleep(50)
      proxy.resume()
      client.write(PING)
      await Bun.sleep(50)

      expect(client.replies()).toBe(
        "-NOPERM User default has no permissions to run the 'ping' command\r\n+PONG\r\n",
      )
      expect(proxy.commands()).toEqual(['PING', 'PING'])
    } finally {
      client.socket.end()
      proxy.stop()
      server.stop()
    }
  })
})

// Returns once `done()` holds or `timeoutMs` has passed; the assertions after it report which. Pass a
// `timeoutMs` that ends at least 2 s before the test's own timeout, so that a delivery that stops short
// fails on those assertions, with both byte counts, rather than as a test timeout.
async function waitUntil(done: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done() && Date.now() < deadline) await Bun.sleep(10)
}

const DELIVERY_TIMEOUT_MS = 10_000
const BACKPRESSURE_TEST_TIMEOUT_MS = 15_000

// About 10 MB each way: more than one socket.write takes on Linux (a few MB), so writes come back
// short and the rest must be written on `drain`. Windows may take all of it in one write, but there
// too the proxy's writes come back short while earlier ones are unsent, so both tests use its queue.
// The test's own client and fake server write with backpressure as the proxy does (`send`, then
// `flush` on `drain`), so whatever arrives short was lost by the proxy.
describe('createReplyDroppingProxy backpressure', () => {
  test('a burst of commands reaches the server whole and in order', async () => {
    const value = 'x'.repeat(200)
    const count = 50_000
    const burst = `*2\r\n$4\r\nECHO\r\n$${value.length}\r\n${value}\r\n`.repeat(count)
    let arrived = ''
    const decoder = new TextDecoder()
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(_socket, data) {
          arrived += decoder.decode(data)
        },
      },
    })
    const proxy = createReplyDroppingProxy(`redis://127.0.0.1:${server.port}`)
    const client = await rawClient(proxy)
    try {
      client.write(burst)
      await waitUntil(() => arrived.length >= burst.length, DELIVERY_TIMEOUT_MS)

      expect(arrived.length).toBe(burst.length)
      expect(arrived === burst).toBe(true)
      expect(proxy.commands().length).toBe(count)
    } finally {
      client.socket.end()
      proxy.stop()
      server.stop(true)
    }
  }, BACKPRESSURE_TEST_TIMEOUT_MS)

  test('a large reply reaches the client whole and in order', async () => {
    const reply = Array.from({ length: 10_000 }, (_, index) => `+${String(index).padEnd(1_000, 'x')}\r\n`).join('')
    const server = Bun.listen<{ pending: Uint8Array[]; replied: boolean }>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(socket) {
          socket.data = { pending: [], replied: false }
        },
        // One reply per connection: a PING that arrives in two chunks must not get two.
        data(socket) {
          if (socket.data.replied) return
          socket.data.replied = true
          send(socket, socket.data.pending, encoder.encode(reply))
        },
        drain(socket) {
          flush(socket, socket.data.pending)
        },
      },
    })
    const proxy = createReplyDroppingProxy(`redis://127.0.0.1:${server.port}`)
    const client = await rawClient(proxy)
    try {
      client.write(PING)
      await waitUntil(() => client.replies().length >= reply.length, DELIVERY_TIMEOUT_MS)

      expect(client.replies().length).toBe(reply.length)
      expect(client.replies() === reply).toBe(true)
    } finally {
      client.socket.end()
      proxy.stop()
      server.stop(true)
    }
  }, BACKPRESSURE_TEST_TIMEOUT_MS)
})
