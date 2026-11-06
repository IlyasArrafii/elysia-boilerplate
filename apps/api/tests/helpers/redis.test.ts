import { describe, expect, test } from 'bun:test'
import type { Socket } from 'bun'
import { createReplyDroppingProxy, createStallingRedis, type ReplyDroppingProxy } from './redis'
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

// A raw client, to control exactly which bytes reach the proxy in which chunk.
async function rawClient(proxy: ReplyDroppingProxy): Promise<{ socket: Socket; replies: () => string }> {
  const decoder = new TextDecoder()
  let replies = ''
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port: Number(new URL(proxy.url).port),
    socket: {
      data(_socket, data) {
        replies += decoder.decode(data)
      },
    },
  })
  return { socket, replies: () => replies }
}

const PING = '*1\r\n$4\r\nPING\r\n'

describe('createReplyDroppingProxy commands', () => {
  test('a command split across chunks is recorded and passed on once whole, pipelined ones each once', async () => {
    const server = createStallingRedis()
    const proxy = createReplyDroppingProxy(server.url)
    const client = await rawClient(proxy)
    try {
      // Every cut lands inside a command: in the `*` line, the name, between CR and LF.
      client.socket.write('*1\r\n$4\r\nPI')
      await Bun.sleep(50)
      expect(proxy.commands()).toEqual([])
      expect(client.replies()).toBe('')

      client.socket.write(`NG\r\n${PING}*1\r`)
      await Bun.sleep(50)
      expect(proxy.commands()).toEqual(['PING', 'PING'])

      client.socket.write('\n$4\r\nping\r\n')
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
      client.socket.write(`*3\r\n$3\r\nSET\r\n$3\r\nkey\r\n$${Buffer.byteLength(value)}\r\n${value}\r\n${PING}`)
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
      client.socket.write(PING)
      await Bun.sleep(50)
      proxy.resume()
      client.socket.write(PING)
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

// Returns once `done()` holds or `timeoutMs` has passed; the assertions after it report which.
async function waitUntil(done: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done() && Date.now() < deadline) await Bun.sleep(10)
}

// About 10 MB each way: far more than a socket takes at once, so the proxy's writes come back short
// and it must write the rest on `drain`. The fakes send theirs in one write on an idle socket, which
// Bun keeps whole.
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
      client.socket.write(burst)
      await waitUntil(() => arrived.length >= burst.length)

      expect(arrived.length).toBe(burst.length)
      expect(arrived === burst).toBe(true)
      expect(proxy.commands().length).toBe(count)
    } finally {
      client.socket.end()
      proxy.stop()
      server.stop(true)
    }
  })

  test('a large reply reaches the client whole and in order', async () => {
    const reply = Array.from({ length: 10_000 }, (_, index) => `+${String(index).padEnd(1_000, 'x')}\r\n`).join('')
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket) {
          socket.write(reply)
        },
      },
    })
    const proxy = createReplyDroppingProxy(`redis://127.0.0.1:${server.port}`)
    const client = await rawClient(proxy)
    try {
      client.socket.write(PING)
      await waitUntil(() => client.replies().length >= reply.length)

      expect(client.replies().length).toBe(reply.length)
      expect(client.replies() === reply).toBe(true)
    } finally {
      client.socket.end()
      proxy.stop()
      server.stop(true)
    }
  })
})
