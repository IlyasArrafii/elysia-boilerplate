import { failed, HEALTHY, healthGet } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { renderToString } from 'react-dom/server'
import { createQueryClient } from '@/lib/query-client'

// Loaded after `./api-mock` has replaced `@/lib/api`: Bun links every static import before running any of them.
const { HealthPage, healthQueryOptions } = await import('@/features/health')

// Rendered the way SSR renders it: whatever the loader left in the cache, with no fetch from the component.
// Click-driven refetch needs a DOM and moves onto the TASK-18 harness (renderWithRouter) once it lands.
function renderPage(client: QueryClient): string {
  return renderToString(
    <QueryClientProvider client={client}>
      <HealthPage />
    </QueryClientProvider>,
  )
}

// The state the browser settles in once its own fetch has failed. A server render would show the loading state
// instead, because the failed query is retried on mount (previous test).
function settledErrorClient(): QueryClient {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, retryOnMount: false } })
  return client
}

beforeEach(() => {
  healthGet.mockReset()
})

describe('HealthPage', () => {
  test('shows the loading state while there is no report yet', () => {
    const html = renderPage(createQueryClient())

    expect(html).toContain('aria-label="Loading API status"')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('Dependencies')
  })

  test('lists every dependency with its state written out', () => {
    const client = createQueryClient()
    client.setQueryData(healthQueryOptions.queryKey, HEALTHY)

    const html = renderPage(client)

    expect(html).toContain('Dependencies')
    for (const text of ['PostgreSQL', 'Redis', 'Log store', '>up<', '>disabled<', '>42<', 'Check again']) {
      expect(html).toContain(text)
    }
    expect(html).not.toContain('Loading API status')
  })

  test('during SSR, a failed prefetch renders the loading state and leaves the retry to the browser', async () => {
    const client = createQueryClient()
    client.setDefaultOptions({ queries: { retry: false } })
    healthGet.mockResolvedValue(failed(429, { code: 'RATE_LIMITED', message: 'Too many requests' }))
    await client.prefetchQuery(healthQueryOptions)

    const html = renderPage(client)

    expect(html).toContain('aria-label="Loading API status"')
    expect(html).not.toContain('role="alert"')
  })

  test('shows the API error code and message with a retry action', async () => {
    const client = settledErrorClient()
    healthGet.mockResolvedValue(failed(429, { code: 'RATE_LIMITED', message: 'Too many requests' }))
    await client.prefetchQuery(healthQueryOptions)

    const html = renderPage(client)

    expect(html).toContain('role="alert"')
    expect(html).toContain('RATE_LIMITED')
    expect(html).toContain('Too many requests')
    expect(html).toContain('Try again')
  })

  test('explains an unreachable API without leaking the raw error', async () => {
    const client = settledErrorClient()
    healthGet.mockRejectedValue(new TypeError('fetch failed'))
    await client.prefetchQuery(healthQueryOptions)

    const html = renderPage(client)

    expect(html).toContain('NETWORK_ERROR')
    expect(html).toContain('The API could not be reached.')
    expect(html).not.toContain('fetch failed')
  })
})
