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

  test('is degraded when a configured Redis is down', async () => {
    withDependencies({ db: 'up', redis: 'down', logStore: 'up' })

    const report = await HealthService.check()

    expect(report.healthy).toBe(false)
    expect(report.body).toMatchObject({ status: 'degraded', redis: 'down' })
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

  test('on the memory fallback and without a database or log-store client, every dependency is disabled', async () => {
    expect(await HealthService.dependencies()).toEqual({ db: 'disabled', redis: 'disabled', logStore: 'disabled' })
  })
})
