import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { HealthService, type Dependencies } from '../../../src/modules/health/service'

let spy: ReturnType<typeof spyOn> | undefined

function withDependencies(dependencies: Dependencies): void {
  spy = spyOn(HealthService, 'dependencies').mockResolvedValue(dependencies)
}

afterEach(() => spy?.mockRestore())

describe('HealthService.check', () => {
  test('is healthy when every dependency is up', async () => {
    withDependencies({ db: 'up', redis: 'up', logStore: 'up' })

    const report = await HealthService.check()

    expect(report.healthy).toBe(true)
    expect(report.body).toMatchObject({ status: 'ok', db: 'up', redis: 'up', logStore: 'up' })
  })

  test('is healthy when Redis and the log store are not configured', async () => {
    withDependencies({ db: 'up', redis: 'disabled', logStore: 'disabled' })

    expect((await HealthService.check()).healthy).toBe(true)
  })

  test('is degraded when the database is down', async () => {
    withDependencies({ db: 'down', redis: 'up', logStore: 'up' })

    const report = await HealthService.check()

    expect(report.healthy).toBe(false)
    expect(report.body).toMatchObject({ status: 'degraded', code: 'SERVICE_UNAVAILABLE', db: 'down' })
  })

  // Nothing fails without Redis: module caches read PostgreSQL and auth rate limits count in memory.
  test('stays healthy when a configured Redis is down, and says so', async () => {
    withDependencies({ db: 'up', redis: 'down', logStore: 'up' })

    const report = await HealthService.check()

    expect(report.healthy).toBe(true)
    expect(report.body).toMatchObject({ status: 'ok', redis: 'down' })
  })

  test('is degraded when the database is down, whatever Redis and the log store report', async () => {
    withDependencies({ db: 'down', redis: 'down', logStore: 'down' })

    const report = await HealthService.check()

    expect(report.healthy).toBe(false)
    expect(report.body).toMatchObject({ status: 'degraded', db: 'down', redis: 'down', logStore: 'down' })
  })

  test('stays healthy when the log store is down, because logging must not take the API down', async () => {
    withDependencies({ db: 'up', redis: 'up', logStore: 'down' })

    const report = await HealthService.check()

    expect(report.healthy).toBe(true)
    expect(report.body).toMatchObject({ status: 'ok', logStore: 'down' })
  })

  test('reports the uptime in whole seconds', async () => {
    withDependencies({ db: 'up', redis: 'up', logStore: 'up' })

    const { body } = await HealthService.check()

    expect(Number.isInteger(body.uptime)).toBe(true)
    expect(body.uptime).toBeGreaterThanOrEqual(0)
  })

  // tests/setup.ts points the database at the test PostgreSQL and leaves Redis and the log store off.
  test('probes the database, and reports Redis on the memory fallback and an empty LOG_MONGO_URL as disabled', async () => {
    expect(await HealthService.dependencies()).toEqual({ db: 'up', redis: 'disabled', logStore: 'disabled' })
  })

  test('runs the probes together, each bounded, so a report takes about one probe timeout at most', async () => {
    const startedAt = performance.now()

    await HealthService.dependencies()

    expect(performance.now() - startedAt).toBeLessThan(1500)
  })
})
