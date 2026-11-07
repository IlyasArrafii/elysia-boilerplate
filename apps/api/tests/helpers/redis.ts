import { resolve } from 'node:path'
import type { Socket } from 'bun'
import { createRedis } from '../../src/utils/redis'

// The Redis of docker-compose.test.yml (TESTING.md §3). Tests that need it skip when it is not
// running, because `bun run test` must pass without Redis.
// TEST_REDIS_URL points them elsewhere, e.g. at a dev Redis: they only touch `test-<uuid>` keys and
// never flush, so a shared Redis keeps its other keys.
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6389'
// Nothing listens on port 1, so the connection is refused at once.
export const UNREACHABLE_REDIS_URL = 'redis://127.0.0.1:1'

export async function isTestRedisRunning(): Promise<boolean> {
  const redis = createRedis(TEST_REDIS_URL)
  try {
    return (await redis.probe()) === 'up'
  } finally {
    redis.close()
  }
}

export interface StallingRedis {
  url: string
  // From now on, read commands and never answer them, on an open connection, like a hung Redis.
  stall(): void
  resume(): void
  // The next `count` PINGs close their connection instead of being answered, as when Redis closed
  // the connection (CLIENT KILL, its `timeout`) just before the PING reached it.
  closeOnPing(count: number): void
  // How many client connections the server has accepted, and seen closed.
  openedConnections(): number
  closedConnections(): number
  stop(): void
}

// The command names in one chunk the client sent. Bun writes the commands of one tick together, so a
// chunk can hold several (two concurrent PINGs), and each needs its own reply. Splits on CRLF, which
// is enough for the commands sent to the stalling fake: none of their arguments contains one.
function commandNames(chunk: string): string[] {
  const lines = chunk.split('\r\n')
  const names: string[] = []
  let line = 0
  while (lines[line]?.startsWith('*')) {
    const argumentCount = Number(lines[line]?.slice(1))
    names.push((lines[line + 2] ?? '').toUpperCase())
    // Each argument is a `$<length>` line followed by its value.
    line += 1 + argumentCount * 2
  }
  return names
}

// Just enough of a Redis server for Bun's client: the RESP3 HELLO handshake and PING. A real Redis
// cannot be made to hold a connection open without replying, which is the case this exists for.
export function createStallingRedis(): StallingRedis {
  let stalled = false
  let pingsToCloseOn = 0
  let opened = 0
  let closed = 0
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {
        opened++
      },
      data(socket, data) {
        if (stalled) return
        for (const name of commandNames(new TextDecoder().decode(data))) {
          if (name === 'HELLO') socket.write('%1\r\n+server\r\n+redis\r\n')
          else if (name === 'PING' && pingsToCloseOn > 0) {
            pingsToCloseOn--
            // A closed connection answers nothing after this, including the rest of the chunk.
            socket.end()
            return
          } else if (name === 'PING') socket.write('+PONG\r\n')
          else socket.write('-ERR unsupported by the stalling fake\r\n')
        }
      },
      close() {
        closed++
      },
    },
  })
  return {
    url: `redis://127.0.0.1:${server.port}`,
    stall: () => {
      stalled = true
    },
    resume: () => {
      stalled = false
    },
    closeOnPing: (count) => {
      pingsToCloseOn = count
    },
    openedConnections: () => opened,
    closedConnections: () => closed,
    stop: () => server.stop(true),
  }
}

export interface ReplyDroppingProxy {
  // A plain `redis://` URL carrying the target's user, password and database, so the client
  // authenticates through the proxy as it would directly. The proxy itself speaks TLS to a
  // `rediss://` target.
  url: string
  // From now on, pass commands on to Redis but throw its replies away, like replies lost on the way
  // back: the commands run and the caller never learns the outcome. With `afterCommand` (e.g.
  // `EXEC`), replies keep flowing until the client sends that command.
  dropReplies(afterCommand?: string): void
  // From now on, answer `command` with a NOPERM error instead of passing it on, as Redis answers a
  // user its ACL denies the command; whatever the client sent after it still goes to Redis.
  refuse(command: string): void
  resume(): void
  // The name of every command clients sent through the proxy so far, upper-cased and in order, the
  // connection's HELLO included. Unlike the server's INFO commandstats, it holds only what went
  // through this proxy, whatever other clients send the server meanwhile.
  commands(): string[]
  stop(): void
}

const CR = 13
const decoder = new TextDecoder()

// The number on a RESP `*<count>` or `$<length>` line.
function headerNumber(line: string, prefix: '*' | '$'): number {
  const value = Number(line.slice(1))
  if (line[0] !== prefix || line.length === 1 || !Number.isInteger(value) || value < 0) {
    throw new Error(`The reply-dropping proxy expected a RESP "${prefix}" line, got ${JSON.stringify(line)}`)
  }
  return value
}

// The CRLF-terminated line at `start` and where the next one starts, or undefined while part of it
// has not arrived.
function readLine(buffer: Uint8Array, start: number): { line: string; next: number } | undefined {
  const cr = buffer.indexOf(CR, start)
  if (cr === -1 || cr + 1 >= buffer.length) return undefined
  return { line: decoder.decode(buffer.subarray(start, cr)), next: cr + 2 }
}

// The command at `start` (an array of bulk strings, the only form Bun's client sends): its name and
// where it ends, or undefined while part of it has not arrived. Bun writes the commands of one tick
// as one chunk, and the network may split a chunk anywhere, so a chunk can hold several commands
// and end inside one. Values are skipped by their byte length, so they may contain anything.
function readCommand(buffer: Uint8Array, start: number): { name: string; end: number } | undefined {
  const header = readLine(buffer, start)
  if (header === undefined) return undefined
  const count = headerNumber(header.line, '*')
  let name = ''
  let next = header.next
  for (let index = 0; index < count; index++) {
    const length = readLine(buffer, next)
    if (length === undefined) return undefined
    const end = length.next + headerNumber(length.line, '$') + 2
    if (end > buffer.length) return undefined
    if (index === 0) name = decoder.decode(buffer.subarray(length.next, end - 2)).toUpperCase()
    next = end
  }
  return { name, end: next }
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const joined = new Uint8Array(head.length + tail.length)
  joined.set(head)
  joined.set(tail, head.length)
  return joined
}

interface Writer {
  write(data: Uint8Array): number
}

// Bun 1.4.4's socket.write sends only the bytes it returns as written and loses the rest (measured:
// past 512 KB on TLS; on TCP past a few MB on Linux, and while earlier writes are still unsent). What
// it does not take waits in `queue`, in order, for the socket's `drain`, as does everything sent
// before `socket` exists. Queued bytes are copies, since `bytes` may be a view into a chunk Bun passed
// to `data`: `new Uint8Array(view)` copies, where a Buffer's `slice` would return another view.
export function send(socket: Writer | undefined, queue: Uint8Array[], bytes: Uint8Array) {
  if (bytes.length === 0) return
  if (socket === undefined || queue.length > 0) {
    queue.push(new Uint8Array(bytes))
    return
  }
  const written = socket.write(bytes)
  // -1: the socket is closing, and its `close` ends the other side.
  if (written >= 0 && written < bytes.length) queue.push(new Uint8Array(bytes.subarray(written)))
}

export function flush(socket: Writer, queue: Uint8Array[]) {
  for (let head = queue[0]; head !== undefined; head = queue[0]) {
    const written = socket.write(head)
    if (written < 0) return
    if (written < head.length) {
      queue[0] = head.subarray(written)
      return
    }
    queue.shift()
  }
}

const encoder = new TextEncoder()

// A TCP proxy in front of a real Redis, for what `createStallingRedis` cannot answer (MULTI/EXEC).
// It reads the commands clients send, to record them and to act on the one `dropReplies` or
// `refuse` names, and passes every byte of them on unchanged, the refused ones excepted.
export function createReplyDroppingProxy(target: string): ReplyDroppingProxy {
  const { hostname, port, username, password, pathname, protocol } = new URL(target)
  // Bun's client also takes e.g. `redis+tls:`, which would otherwise get a plaintext upstream here and
  // fail with an unexplained closed connection.
  if (protocol !== 'redis:' && protocol !== 'rediss:') {
    throw new Error(`createReplyDroppingProxy takes redis:// or rediss:// targets, not ${protocol}//`)
  }
  const secure = protocol === 'rediss:'
  let dropping = false
  let dropAfter: string | undefined
  let refused: string | undefined
  const sent: string[] = []
  interface Pair {
    // Set once the upstream connection takes writes.
    upstream?: Socket
    // What waits to be written upstream (all the client sent until then) and to the client.
    toUpstream: Uint8Array[]
    toClient: Uint8Array[]
    // The start of a command whose rest has not arrived.
    unparsed: Uint8Array
    closed: boolean
  }

  function forward(pair: Pair, bytes: Uint8Array) {
    send(pair.upstream, pair.toUpstream, bytes)
  }

  function connectUpstream(client: Socket<Pair>) {
    const pair = client.data
    const ready = (upstream: Socket) => {
      if (pair.closed) {
        upstream.end()
        return
      }
      pair.upstream = upstream
      flush(upstream, pair.toUpstream)
    }
    Bun.connect({
      hostname,
      port: Number(port || 6379),
      // Verified against the system CAs plus NODE_EXTRA_CA_CERTS, under the target's host name.
      ...(secure ? { tls: { serverName: hostname } } : {}),
      socket: {
        open(upstream) {
          if (!secure) ready(upstream)
        },
        // Bun 1.4.4 silently drops what is written to a TLS socket before its handshake, although
        // `open` and Bun.connect's promise come first.
        handshake(upstream, success) {
          if (success) ready(upstream)
          else upstream.end()
        },
        data(_upstream, data) {
          if (!dropping) send(client, pair.toClient, data)
        },
        drain(upstream) {
          if (pair.upstream === upstream) flush(upstream, pair.toUpstream)
        },
        close() {
          client.end()
        },
        error() {
          client.end()
        },
      },
    }).catch(() => client.end())
  }

  const server = Bun.listen<Pair>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        client.data = { toUpstream: [], toClient: [], unparsed: new Uint8Array(0), closed: false }
        connectUpstream(client)
      },
      data(client, received) {
        const pair = client.data
        const buffer = pair.unparsed.length === 0 ? received : concat(pair.unparsed, received)
        let forwardFrom = 0
        let start = 0
        for (let command = readCommand(buffer, start); command !== undefined; command = readCommand(buffer, start)) {
          sent.push(command.name)
          if (command.name === dropAfter) {
            dropping = true
            dropAfter = undefined
          }
          // Answered at once, ahead of any reply still due for an earlier command: in order only
          // because nothing is outstanding upstream when a client sends MULTI, the one command
          // tests refuse.
          if (command.name === refused) {
            forward(pair, buffer.subarray(forwardFrom, start))
            send(
              client,
              pair.toClient,
              encoder.encode(`-NOPERM User default has no permissions to run the '${refused.toLowerCase()}' command\r\n`),
            )
            forwardFrom = command.end
          }
          start = command.end
        }
        forward(pair, buffer.subarray(forwardFrom, start))
        // A copy, kept past this call: `buffer` may be the chunk Bun passed in.
        pair.unparsed = new Uint8Array(buffer.subarray(start))
      },
      drain(client) {
        flush(client, client.data.toClient)
      },
      close(client) {
        client.data.closed = true
        client.data.upstream?.end()
      },
    },
  })

  const url = new URL(`redis://127.0.0.1:${server.port}`)
  // `URL` keeps them percent-encoded, and the setters leave existing `%` escapes as they are.
  url.username = username
  url.password = password
  // The database number, e.g. `/2`.
  url.pathname = pathname
  return {
    url: url.href,
    dropReplies: (afterCommand) => {
      if (afterCommand === undefined) dropping = true
      else dropAfter = afterCommand.toUpperCase()
    },
    refuse: (command) => {
      refused = command.toUpperCase()
    },
    resume: () => {
      dropping = false
      dropAfter = undefined
      refused = undefined
    },
    commands: () => [...sent],
    stop: () => server.stop(true),
  }
}

// Keeps parallel runs and earlier runs from seeing each other's keys on the shared test Redis.
export function uniqueModule(): string {
  return `test-${crypto.randomUUID().slice(0, 8)}`
}

const API_ROOT = resolve(import.meta.dir, '../..')
const OWN_VARIABLES = [
  'NODE_ENV',
  'LOG_LEVEL',
  'PORT',
  'APP_VERSION',
  'REDIS_URL',
  'AUTH_REDIS_DRIVER',
  'LOG_MONGO_URL',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'WEB_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'HOST',
  'CLIENT_IP_HEADER',
  'TEST',
]

// Placeholders for what development requires (TASK-04). Nothing dials them: the pool is lazy.
export const REQUIRED_ENV: Record<string, string> = {
  DATABASE_URL: 'postgres://app:placeholder@127.0.0.1:1/app',
  BETTER_AUTH_SECRET: 'placeholder-secret-for-startup-tests-only',
}

// Everything else production requires, so a production test changes only the variable it is about.
export const PRODUCTION_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  LOG_MONGO_URL: 'mongodb://log_writer:placeholder@127.0.0.1:1/app_logs?authSource=app_logs',
  BETTER_AUTH_URL: 'https://app.example.test',
  WEB_URL: 'https://app.example.test',
  GOOGLE_CLIENT_ID: 'placeholder-client-id',
  GOOGLE_CLIENT_SECRET: 'placeholder-client-secret',
  CLIENT_IP_HEADER: 'cf-connecting-ip',
}

export interface ApiProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  // True when `timeoutMs` passed and the process was killed.
  killed: boolean
}

export interface ApiProcessOptions {
  // Kills a process that has not exited by then, so a hang fails the test instead of the run.
  timeoutMs?: number
}

// `env.ts` and `utils/redis` resolve once at import, so a different REDIS_URL needs a fresh process.
export async function runInApiProcess(
  script: string,
  overrides: Record<string, string>,
  options: ApiProcessOptions = {},
): Promise<ApiProcessResult> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !OWN_VARIABLES.includes(key)))
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', script],
    cwd: API_ROOT,
    env: { ...inherited, NODE_ENV: 'test', ...REQUIRED_ENV, ...overrides },
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs, killSignal: 'SIGKILL' as const }),
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr, killed: child.signalCode !== null }
}
