import { resolve } from 'node:path'
import { createRedis } from '../../src/utils/redis'

// The Redis of docker-compose.test.yml (TESTING.md §3). Tests that need it skip when it is not
// running, because `bun run test` must pass without Redis.
export const TEST_REDIS_URL = 'redis://127.0.0.1:6389'
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
  // How many client connections the server has seen closed.
  closedConnections(): number
  stop(): void
}

// Just enough of a Redis server for Bun's client: the RESP3 HELLO handshake and PING. A real Redis
// cannot be made to hold a connection open without replying, which is the case this exists for.
export function createStallingRedis(): StallingRedis {
  let stalled = false
  let closed = 0
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(socket, data) {
        if (stalled) return
        const command = new TextDecoder().decode(data)
        if (command.includes('HELLO')) socket.write('%1\r\n+server\r\n+redis\r\n')
        else if (command.includes('PING')) socket.write('+PONG\r\n')
        else socket.write('-ERR unsupported by the stalling fake\r\n')
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
    closedConnections: () => closed,
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
  'LOG_MONGO_URL',
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'WEB_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
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
