import { failed, HEALTHY, healthGet, ok } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { QueryClient } from '@tanstack/react-query'
import { healthKeys } from '@/features/health/lib/keys'
import { ApiError } from '@/lib/api-error'
import { createQueryClient } from '@/lib/query-client'

// Loaded after `./api-mock` has replaced `@/lib/api`: Bun links every static import before running any of them.
const { healthQueryOptions } = await import('@/features/health')

// The app's real QueryClient defaults (retry policy included), minus the back-off wait.
function testClient(): QueryClient {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } })
  return client
}

const DEGRADED = {
  code: 'SERVICE_UNAVAILABLE',
  message: 'A dependency is down',
  status: 'degraded',
  db: 'down',
  redis: 'up',
  logStore: 'up',
  uptime: 7,
}

beforeEach(() => {
  healthGet.mockReset()
})

describe('healthQueryOptions', () => {
  test('uses the key from the factory', () => {
    expect([...healthQueryOptions.queryKey]).toEqual([...healthKeys.status()])
  })

  test('resolves with the health report', async () => {
    healthGet.mockResolvedValue(ok(HEALTHY))

    await expect(testClient().fetchQuery(healthQueryOptions)).resolves.toEqual(HEALTHY)
    expect(healthGet).toHaveBeenCalledTimes(1)
  })

  test('throws an ApiError carrying status and code when the API reports degraded', async () => {
    healthGet.mockResolvedValue(failed(503, DEGRADED))

    const error = await testClient()
      .fetchQuery(healthQueryOptions)
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 503, code: 'SERVICE_UNAVAILABLE', message: 'A dependency is down' })
  })

  test('maps a body that is not the API error format (dev proxy, API down) to INTERNAL_ERROR', async () => {
    healthGet.mockResolvedValue(failed(502, ''))

    await expect(testClient().fetchQuery(healthQueryOptions)).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' })
  })

  test('retries a 5xx once, then succeeds', async () => {
    healthGet.mockResolvedValueOnce(failed(503, DEGRADED)).mockResolvedValueOnce(ok(HEALTHY))

    await expect(testClient().fetchQuery(healthQueryOptions)).resolves.toEqual(HEALTHY)
    expect(healthGet).toHaveBeenCalledTimes(2)
  })

  test('retries a network failure once, then gives up with a NETWORK_ERROR that keeps the original error', async () => {
    const cause = new TypeError('fetch failed')
    healthGet.mockRejectedValue(cause)

    const error = await testClient().fetchQuery(healthQueryOptions).catch((thrown: unknown) => thrown)
    expect(error).toMatchObject({ name: 'ApiError', status: 0, code: 'NETWORK_ERROR', network: true, cause })
    expect(healthGet).toHaveBeenCalledTimes(2)
  })

  test('does not retry a 4xx', async () => {
    healthGet.mockResolvedValue(failed(429, { code: 'RATE_LIMITED', message: 'Too many requests' }))

    await expect(testClient().fetchQuery(healthQueryOptions)).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED' })
    expect(healthGet).toHaveBeenCalledTimes(1)
  })

  test('a refetch asks the API again and replaces the cached report', async () => {
    const client = testClient()
    healthGet.mockResolvedValueOnce(ok(HEALTHY)).mockResolvedValueOnce(ok({ ...HEALTHY, redis: 'up', uptime: 99 }))

    await client.fetchQuery(healthQueryOptions)
    await client.refetchQueries({ queryKey: healthKeys.all })

    expect(healthGet).toHaveBeenCalledTimes(2)
    expect(client.getQueryData(healthQueryOptions.queryKey)).toMatchObject({ redis: 'up', uptime: 99 })
  })
})
