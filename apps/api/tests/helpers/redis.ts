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
  url: string
  // From now on, pass commands on to Redis but throw its replies away, like replies lost on the way
  // back: the commands run and the caller never learns the outcome. With `afterCommand` (e.g.
  // `EXEC`), replies keep flowing until the client sends that command.
  dropReplies(afterCommand?: string): void
  // From now on, answer `command` with a NOPERM error instead of passing it on, as Redis answers a
  // user its ACL denies the command; whatever the client sent after it still goes to Redis.
  refuse(command: string): void
  resume(): void
  stop(): void
}

// A TCP proxy in front of a real Redis, for what `createStallingRedis` cannot answer (MULTI/EXEC).
export function createReplyDroppingProxy(target: string): ReplyDroppingProxy {
  const { hostname, port } = new URL(target)
  let dropping = false
  let dropAfter: string | undefined
  let refused: string | undefined
  interface Pair {
    upstream?: Socket
    // What the client sent before the upstream connection was open.
    pending: Uint8Array[]
  }
  const server = Bun.listen<Pair>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        client.data = { pending: [] }
        Bun.connect({
          hostname,
          port: Number(port),
          socket: {
            data(_upstream, data) {
              if (!dropping) client.write(data)
            },
            close() {
              client.end()
            },
            error() {
              client.end()
            },
          },
        }).then(
          (upstream) => {
            client.data.upstream = upstream
            for (const chunk of client.data.pending) upstream.write(chunk)
            client.data.pending = []
          },
          () => client.end(),
        )
      },
      data(client, received) {
        let data = received
        // A RESP command name is a bulk string on a line of its own.
        if (dropAfter !== undefined && new TextDecoder().decode(data).includes(`\r\n${dropAfter}\r\n`)) {
          dropping = true
          dropAfter = undefined
        }
        // Only a refused command at the start of a chunk, which keeps the replies in order: nothing
        // is outstanding upstream when a client sends MULTI, the one command tests refuse.
        if (refused !== undefined) {
          const frame = `*1\r\n$${refused.length}\r\n${refused}\r\n`
          if (new TextDecoder().decode(data.subarray(0, frame.length)).toUpperCase() === frame) {
            client.write(`-NOPERM User default has no permissions to run the '${refused.toLowerCase()}' command\r\n`)
            data = data.subarray(frame.length)
            if (data.length === 0) return
          }
        }
        if (client.data.upstream === undefined) client.data.pending.push(data.slice())
        else client.data.upstream.write(data)
      },
      close(client) {
        client.data.upstream?.end()
      },
    },
  })
  return {
    url: `redis://127.0.0.1:${server.port}`,
    dropReplies: (afterCommand) => {
      if (afterCommand === undefined) dropping = true
      else dropAfter = afterCommand
    },
    refuse: (command) => {
      refused = command.toUpperCase()
    },
    resume: () => {
      dropping = false
      dropAfter = undefined
      refused = undefined
    },
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
