import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { app } from '../../../src/app'
import { HealthService, type Dependencies } from '../../../src/modules/health/service'
import { memory, request } from '../../helpers/app'
import { testDatabaseUrl } from '../../helpers/db'
import { isTestRedisRunning, REQUIRED_ENV, runInApiProcess, TEST_REDIS_URL, UNREACHABLE_REDIS_URL } from '../../helpers/redis'
import { createSilentServer } from '../../helpers/silent-server'

let spy: ReturnType<typeof spyOn> | undefined

function withDependencies(dependencies: Dependencies): void {
  spy = spyOn(HealthService, 'dependencies').mockResolvedValue(dependencies)
}

beforeEach(() => memory.clear())
afterEach(() => spy?.mockRestore())

describe('root app', () => {
  test('importing it opens no port', () => {
    expect(app.server).toBeNull()
  })

  test('serves under /api only', async () => {
    expect((await request('/health')).status).toBe(404)
    expect((await request('/api/health')).status).toBe(200)
  })
})

describe('GET /api/health', () => {
  test('is public and answers 200 with the documented shape', async () => {
    const response = await request('/api/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      db: 'up',
      redis: expect.stringMatching(/^(up|disabled)$/),
      logStore: expect.stringMatching(/^(up|disabled)$/),
      uptime: expect.any(Number),
    })
  })

  test('answers with and without a trailing slash', async () => {
    expect((await request('/api/health/')).status).toBe(200)
  })

  test('has an x-request-id header', async () => {
    const response = await request('/api/health')

    expect(response.headers.get('x-request-id')).toBeString()
  })

  test('is logged at debug with module health and the route pattern', async () => {
    const response = await request('/api/health')

    expect(memory.find('http.request')).toEqual([
      expect.objectContaining({
        level: 'debug',
        module: 'health',
        route: '/api/health',
        status: 200,
        requestId: response.headers.get('x-request-id'),
      }),
    ])
  })

  test('answers 503 degraded when the database is down', async () => {
    withDependencies({ db: 'down', redis: 'up', logStore: 'up' })

    const response = await request('/api/health')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'A required dependency is down',
      status: 'degraded',
      db: 'down',
      redis: 'up',
      logStore: 'up',
      uptime: expect.any(Number),
    })
  })

  test('answers 503 when a configured Redis is down', async () => {
    withDependencies({ db: 'up', redis: 'down', logStore: 'up' })

    expect((await request('/api/health')).status).toBe(503)
  })

  test('answers 200 when the log store is down', async () => {
    withDependencies({ db: 'up', redis: 'up', logStore: 'down' })

    const response = await request('/api/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', logStore: 'down' })
  })

  test('answers 200 when Redis is not configured', async () => {
    withDependencies({ db: 'up', redis: 'disabled', logStore: 'up' })

    expect((await request('/api/health')).status).toBe(200)
  })

  test('reports redis disabled on the memory fallback', async () => {
    const response = await request('/api/health')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', redis: 'disabled' })
  })

  test('answers 500 INTERNAL_ERROR, tagged health, if a probe itself throws', async () => {
    spy = spyOn(HealthService, 'dependencies').mockRejectedValue(new Error('probe crashed'))

    const response = await request('/api/health')

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
    expect(memory.find('http.error')[0]).toMatchObject({ module: 'health', status: 500 })
  })
})

// The clients are resolved once at import from the environment, so each case runs the app in its
// own process. PostgreSQL is the test database unless a case says otherwise; the log store is off.
async function healthWith(
  redisUrl: string,
  overrides: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; durationMs: number }> {
  const script = `
    const { app } = await import("./src/app.ts")
    const startedAt = performance.now()
    const response = await app.handle(new Request("http://localhost/api/health"))
    const durationMs = performance.now() - startedAt
    console.log(JSON.stringify({ status: response.status, body: await response.json(), durationMs }))
    // A stalled server keeps the clients' sockets open, so the process is ended rather than drained.
    process.exit(0)
  `
  const result = await runInApiProcess(
    script,
    { LOG_LEVEL: 'silent', DATABASE_URL: testDatabaseUrl(), LOG_MONGO_URL: '', REDIS_URL: redisUrl, ...overrides },
    { timeoutMs: 15_000 },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout)
}

const redisRunning = await isTestRedisRunning()

describe('GET /api/health with the real Redis wiring', () => {
  test('reports redis disabled and 200 when REDIS_URL is empty', async () => {
    expect(await healthWith('')).toMatchObject({ status: 200, body: expect.objectContaining({ status: 'ok', redis: 'disabled' }) })
  })

  test('reports redis down and 503 when Redis is unreachable', async () => {
    expect(await healthWith(UNREACHABLE_REDIS_URL)).toMatchObject({
      status: 503,
      body: expect.objectContaining({ code: 'SERVICE_UNAVAILABLE', status: 'degraded', redis: 'down' }),
    })
  })

  test.skipIf(!redisRunning)('reports redis up and 200 with Redis running (docker-compose.test.yml)', async () => {
    expect(await healthWith(TEST_REDIS_URL)).toMatchObject({ status: 200, body: expect.objectContaining({ status: 'ok', redis: 'up' }) })
  })
})

// TEST_LOG_MONGO_URL: see tests/utils/mongo/log-store.test.ts.
const LOG_WRITER_URL = process.env.TEST_LOG_MONGO_URL

describe('GET /api/health with the real database and log-store wiring', () => {
  test('reports db up with the test PostgreSQL', async () => {
    expect(await healthWith('')).toMatchObject({ status: 200, body: { db: 'up', logStore: 'disabled' } })
  })

  test('reports db down and 503 when PostgreSQL refuses connections', async () => {
    expect(await healthWith('', { DATABASE_URL: REQUIRED_ENV.DATABASE_URL ?? '' })).toMatchObject({
      status: 503,
      body: { code: 'SERVICE_UNAVAILABLE', status: 'degraded', db: 'down' },
    })
  })

  test('reports db down and 503 within the probe timeout when PostgreSQL accepts but never answers', async () => {
    const silent = await createSilentServer()
    try {
      const report = await healthWith('', { DATABASE_URL: `postgres://app:x@127.0.0.1:${silent.port}/app_test` })

      expect(report).toMatchObject({ status: 503, body: { db: 'down' } })
      expect(report.durationMs).toBeLessThan(2000)
    } finally {
      await silent.stop()
    }
  })

  test('reports logStore down but stays 200 when only the log store is unreachable', async () => {
    const silent = await createSilentServer()
    try {
      const report = await healthWith('', {
        LOG_MONGO_URL: `mongodb://log_writer:x@127.0.0.1:${silent.port}/app_logs?authSource=app_logs`,
      })

      expect(report).toMatchObject({ status: 200, body: { status: 'ok', db: 'up', logStore: 'down' } })
      expect(report.durationMs).toBeLessThan(2000)
    } finally {
      await silent.stop()
    }
  })

  test.skipIf(LOG_WRITER_URL === undefined)('reports logStore up with the test MongoDB', async () => {
    expect(await healthWith('', { LOG_MONGO_URL: LOG_WRITER_URL ?? '' })).toMatchObject({
      status: 200,
      body: { status: 'ok', db: 'up', logStore: 'up' },
    })
  })
})
