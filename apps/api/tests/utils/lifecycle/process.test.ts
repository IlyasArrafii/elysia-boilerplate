import { afterAll, describe, expect, test } from 'bun:test'
import { MongoClient } from 'mongodb'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'
import { testDatabaseUrl } from '../../helpers/db'
import { isTestRedisRunning, REQUIRED_ENV, runInApiProcess, TEST_REDIS_URL } from '../../helpers/redis'
import { createSilentServer, freePort } from '../../helpers/silent-server'

// The real `src/index.ts` in a child process, against the test stores. Windows cannot deliver a
// signal to another process (Bun terminates it without running any handler), so these tests send
// it from inside the child with `process.emit`, which runs the listeners `index.ts` installed. The
// last describe sends real signals where the platform allows.
//
// MongoDB is used when the log-store tests' variables are set (tests/utils/mongo/log-store.test.ts).
const WRITER_URL = process.env.TEST_LOG_MONGO_URL
const ADMIN_URL = process.env.TEST_LOG_MONGO_ADMIN_URL
const redisRunning = await isTestRedisRunning()
const PROCESS_TIMEOUT_MS = 20_000
const API_ROOT = resolve(import.meta.dir, '../../..')

type Line = Record<string, unknown>

interface Run {
  exitCode: number
  killed: boolean
  logs: Line[]
  // Written by the script to stderr: what it saw, and when it sent the signals.
  markers: Line
  shutdownMs: number
}

function parseLines(text: string): Line[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line): Line => JSON.parse(line))
}

function storesEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    LOG_LEVEL: 'info',
    PORT: String(freePort()),
    APP_VERSION: `test-shutdown-${crypto.randomUUID()}`,
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: redisRunning ? TEST_REDIS_URL : '',
    LOG_MONGO_URL: WRITER_URL ?? '',
    ...overrides,
  }
}

// Starts the API, answers one request, then sends SIGTERM twice and SIGINT once, and checks that a
// request after them is refused. The process must then end by itself.
const SHUTDOWN_SCRIPT = `
  await import("./src/index.ts")
  const url = "http://127.0.0.1:" + process.env.PORT + "/api/health"
  const before = await fetch(url).then((r) => r.status)
  const signalledAt = Date.now()
  process.emit("SIGTERM")
  process.emit("SIGTERM")
  process.emit("SIGINT")
  const after = await fetch(url).then((r) => r.status, () => "refused")
  process.on("exit", (code) => console.error(JSON.stringify({ before, after, signalledAt, exitedAt: Date.now(), code })))
`

async function runShutdown(env: Record<string, string>): Promise<Run> {
  const result = await runInApiProcess(SHUTDOWN_SCRIPT, env, { timeoutMs: PROCESS_TIMEOUT_MS })
  const markers = parseLines(result.stderr).at(-1) ?? {}
  const shutdownMs = Number(markers.exitedAt) - Number(markers.signalledAt)
  return { exitCode: result.exitCode, killed: result.killed, logs: parseLines(result.stdout), markers, shutdownMs }
}

const summaryOf = (logs: Line[]) => logs.find(({ msg }) => msg === 'Cleanup complete' || msg === 'Shutdown finished with failures')
const events = (logs: Line[], event: string) => logs.filter((line) => line.event === event)

describe('importing the app', () => {
  test('installs no signal listener and starts no server; only src/index.ts does', async () => {
    const script = `
      const count = () => [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]
      const before = count()
      const { app } = await import("./src/app.ts")
      await import("./src/utils/lifecycle/index.ts")
      console.log(JSON.stringify({ before, after: count(), server: app.server }))
      process.exit(0)
    `
    const result = await runInApiProcess(script, { LOG_LEVEL: 'silent' }, { timeoutMs: PROCESS_TIMEOUT_MS })

    expect(result.exitCode).toBe(0)
    const [report] = parseLines(result.stdout)
    expect(report).toEqual({ before: [0, 0], after: [0, 0], server: null })
  })
})

// The address other machines would use: the first non-internal IPv4 of this host, if it has one.
const EXTERNAL_IPV4 =
  Object.values(networkInterfaces())
    .flat()
    .find((address) => address !== undefined && address.family === 'IPv4' && !address.internal)?.address ?? null

describe('src/index.ts listens on HOST', () => {
  // Starts the API with HOST, then asks /api/health on loopback and on this host's external IPv4.
  async function probe(host: string): Promise<Line> {
    const script = `
      await import("./src/index.ts")
      const { app } = await import("./src/app.ts")
      const ask = (address) =>
        fetch("http://" + address + ":" + process.env.PORT + "/api/health", { signal: AbortSignal.timeout(3000) })
          .then((response) => response.status, () => "unreachable")
      const external = ${JSON.stringify(EXTERNAL_IPV4)}
      console.error(JSON.stringify({
        hostname: app.server.hostname,
        loopback: await ask("127.0.0.1"),
        external: external === null ? null : await ask(external),
      }))
      process.exit(0)
    `
    const result = await runInApiProcess(script, storesEnv({ LOG_LEVEL: 'silent', HOST: host }), { timeoutMs: PROCESS_TIMEOUT_MS })
    expect(result.exitCode).toBe(0)
    return parseLines(result.stderr).at(-1) ?? {}
  }

  test(
    'binds to 127.0.0.1 by default, so the port does not answer on an external address',
    async () => {
      const report = await probe('')

      expect(report).toMatchObject({ hostname: '127.0.0.1', loopback: expect.any(Number) })
      if (EXTERNAL_IPV4 !== null) expect(report.external).toBe('unreachable')
    },
    PROCESS_TIMEOUT_MS + 5000,
  )

  // The other side of the test above: the probe does reach the external address when the API listens there.
  test.skipIf(EXTERNAL_IPV4 === null)(
    'HOST=0.0.0.0 answers on the external address too',
    async () => {
      expect(await probe('0.0.0.0')).toMatchObject({ hostname: '0.0.0.0', loopback: expect.any(Number), external: expect.any(Number) })
    },
    PROCESS_TIMEOUT_MS + 5000,
  )
})

describe('graceful shutdown of src/index.ts', () => {
  const versions: string[] = []
  afterAll(async () => {
    if (ADMIN_URL === undefined || versions.length === 0) return
    // Only the documents these tests wrote; the log store is shared.
    const admin = new MongoClient(ADMIN_URL, { serverSelectionTimeoutMS: 3000 })
    try {
      await admin.db().collection('log_event').deleteMany({ version: { $in: versions } })
    } finally {
      await admin.close()
    }
  })

  test(
    'stops taking requests, emits app.stopping once, closes every client and exits 0 by itself in < 10 s',
    async () => {
      const env = storesEnv()
      const run = await runShutdown(env)

      expect(run.killed).toBe(false)
      expect(run.exitCode).toBe(0)
      expect(run.markers).toMatchObject({ before: expect.any(Number), after: 'refused', code: 0 })
      expect(run.shutdownMs).toBeLessThan(10_000)

      expect(events(run.logs, 'app.stopping')).toEqual([expect.objectContaining({ version: env.APP_VERSION, module: 'core' })])
      expect(run.logs.filter(({ msg }) => msg === 'Shutting down')).toHaveLength(1)
      expect(run.logs.filter(({ msg }) => msg === 'Already shutting down; signal ignored')).toHaveLength(2)
      expect(summaryOf(run.logs)).toMatchObject({
        msg: 'Cleanup complete',
        signal: 'SIGTERM',
        steps: {
          announce: 'ok',
          server: 'ok',
          'telemetry.flush': 'ok',
          'telemetry.close': 'ok',
          postgres: 'ok',
          redis: 'ok',
          logStore: 'ok',
        },
      })
      // app.stopping comes before the flush is reported done, i.e. it was in the flushed buffer.
      const stoppingAt = run.logs.findIndex(({ event }) => event === 'app.stopping')
      expect(stoppingAt).toBeLessThan(run.logs.findIndex(({ msg }) => msg === 'Cleanup complete'))
    },
    PROCESS_TIMEOUT_MS + 5000,
  )

  test.skipIf(WRITER_URL === undefined || ADMIN_URL === undefined)(
    'stores app.started and app.stopping in MongoDB before the process exits',
    async () => {
      const env = storesEnv()
      versions.push(env.APP_VERSION ?? '')
      const run = await runShutdown(env)
      expect(run.exitCode).toBe(0)

      const admin = new MongoClient(ADMIN_URL ?? '', { serverSelectionTimeoutMS: 3000 })
      try {
        const stored = await admin.db().collection('log_event').find({ version: env.APP_VERSION }).toArray()
        expect(stored.map(({ event }) => event).sort()).toEqual(['app.started', 'app.stopping'])
      } finally {
        await admin.close()
      }
    },
    PROCESS_TIMEOUT_MS + 5000,
  )

  test(
    'a stalled log store fails the flush, every client is still closed, and it exits 1 in < 10 s',
    async () => {
      const silent = await createSilentServer()
      try {
        const run = await runShutdown(
          storesEnv({ LOG_MONGO_URL: `mongodb://log_writer:x@127.0.0.1:${silent.port}/app_logs?authSource=app_logs` }),
        )

        expect(run.killed).toBe(false)
        expect(run.exitCode).toBe(1)
        expect(run.shutdownMs).toBeLessThan(10_000)
        // stdout still has every line.
        expect(events(run.logs, 'app.stopping')).toHaveLength(1)
        const summary = summaryOf(run.logs)
        const steps = summary?.steps as Record<string, string> | undefined
        expect(summary).toMatchObject({
          msg: 'Shutdown finished with failures',
          steps: { announce: 'ok', server: 'ok', 'telemetry.flush': 'failed', 'telemetry.close': 'ok', postgres: 'ok', redis: 'ok' },
        })
        // Closing a client that never finished its handshake may or may not wait on the server.
        expect(['ok', 'timed_out']).toContain(steps?.logStore ?? 'missing')
        expect(run.logs).toContainEqual(expect.objectContaining({ msg: 'Shutdown step failed', step: 'telemetry.flush' }))
      } finally {
        await silent.stop()
      }
    },
    PROCESS_TIMEOUT_MS + 5000,
  )

  test(
    'a stalled PostgreSQL is cut off by its client timeout and reported, and it exits 1 in < 10 s',
    async () => {
      const silent = await createSilentServer()
      try {
        // The startup unknown-role check opens a connection that never gets an answer.
        const run = await runShutdown(storesEnv({ DATABASE_URL: `postgres://app:x@127.0.0.1:${silent.port}/app_test` }))

        expect(run.killed).toBe(false)
        expect(run.exitCode).toBe(1)
        expect(run.shutdownMs).toBeLessThan(10_000)
        expect(summaryOf(run.logs)).toMatchObject({
          msg: 'Shutdown finished with failures',
          steps: { 'telemetry.flush': 'ok', postgres: 'failed', redis: 'ok', logStore: 'ok' },
        })
        expect(run.logs).toContainEqual(
          expect.objectContaining({
            msg: 'Shutdown step failed',
            step: 'postgres',
            err: expect.objectContaining({ message: expect.stringContaining('terminated') }),
          }),
        )
      } finally {
        await silent.stop()
      }
    },
    PROCESS_TIMEOUT_MS + 5000,
  )
})

// Real signals from another process. Not on Windows (see the top of this file).
describe.skipIf(process.platform === 'win32')('src/index.ts on a real signal', () => {
  async function stopWith(signal: 'SIGTERM' | 'SIGINT'): Promise<{ exitCode: number; logs: Line[] }> {
    const child = Bun.spawn({
      cmd: [process.execPath, 'src/index.ts'],
      cwd: API_ROOT,
      env: { ...process.env, NODE_ENV: 'test', ...REQUIRED_ENV, ...storesEnv() },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: PROCESS_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ''
    while (!output.includes('"app.started"')) {
      const { value, done } = await reader.read()
      if (done) break
      output += decoder.decode(value)
    }
    child.kill(signal)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      output += decoder.decode(value)
    }
    return { exitCode: await child.exited, logs: parseLines(output) }
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(
      `${signal} shuts down cleanly and exits 0`,
      async () => {
        const { exitCode, logs } = await stopWith(signal)

        expect(exitCode).toBe(0)
        expect(events(logs, 'app.stopping')).toHaveLength(1)
        expect(summaryOf(logs)).toMatchObject({ msg: 'Cleanup complete', signal })
      },
      PROCESS_TIMEOUT_MS + 5000,
    )
  }
})
