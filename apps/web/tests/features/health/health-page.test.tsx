import { failed, HEALTHY, healthGet, ok, type HealthGetResult } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderToString } from 'react-dom/server'
import { createQueryClient } from '@/lib/query-client'

// Loaded after `./api-mock` has replaced `@/lib/api`: Bun links every static import before running any of them.
const { HealthPage, healthQueryOptions } = await import('@/features/health')

// The app's real QueryClient defaults (retry policy included), minus the back-off wait.
function testClient(): QueryClient {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } })
  return client
}

// Mounted in the DOM from tests/setup.ts, so the page fetches, re-renders and reacts to clicks as in the browser.
function renderPage(client = testClient()) {
  return render(
    <QueryClientProvider client={client}>
      <HealthPage />
    </QueryClientProvider>,
  )
}

// A response the test releases by hand, to look at the page while the request is still in flight.
function deferred() {
  let resolve!: (result: HealthGetResult) => void
  const promise = new Promise<HealthGetResult>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// The "State" cell in a service's row of the dependency table.
function stateOf(service: string): HTMLElement {
  const [, state] = within(screen.getByRole('row', { name: new RegExp(service) })).getAllByRole('cell')
  if (state === undefined) throw new Error(`no state cell in the ${service} row`)
  return state
}

beforeEach(() => {
  healthGet.mockReset()
})

describe('HealthPage', () => {
  test('shows the loading state until the report arrives, then lists every dependency', async () => {
    const response = deferred()
    healthGet.mockReturnValue(response.promise)

    renderPage()

    expect(screen.getByLabelText('Loading API status')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true)

    response.resolve(ok(HEALTHY))

    expect(await screen.findByRole('heading', { level: 2, name: 'Dependencies' })).toBeDefined()
    expect(screen.queryByLabelText('Loading API status')).toBeNull()
    expect(stateOf('PostgreSQL').textContent).toBe('up')
    expect(stateOf('Redis').textContent).toBe('disabled')
    expect(stateOf('Log store').textContent).toBe('up')
    expect(screen.getByText('42s')).toBeDefined()
  })

  test('"Check again" asks the API again and shows the new report', async () => {
    const user = userEvent.setup()
    const second = deferred()
    healthGet.mockResolvedValueOnce(ok(HEALTHY)).mockReturnValueOnce(second.promise)
    renderPage()
    await screen.findByText('42s')

    await user.click(screen.getByRole('button', { name: 'Check again' }))

    // The old report stays readable while the new one loads; the button says it is working.
    expect(screen.getByRole('button', { name: 'Checking…' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('42s')).toBeDefined()

    second.resolve(ok({ ...HEALTHY, redis: 'up', uptime: 99 }))

    expect(await screen.findByText('99s')).toBeDefined()
    expect(stateOf('Redis').textContent).toBe('up')
    expect(screen.getByRole('button', { name: 'Check again' }).hasAttribute('disabled')).toBe(false)
    expect(healthGet).toHaveBeenCalledTimes(2)
  })

  test('shows the API error code and message, and "Try again" recovers', async () => {
    const user = userEvent.setup()
    // A 4xx is not retried automatically (src/lib/query-client.ts), so the error shows after one call.
    healthGet
      .mockResolvedValueOnce(failed(429, { code: 'RATE_LIMITED', message: 'Too many requests' }))
      .mockResolvedValueOnce(ok(HEALTHY))
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('RATE_LIMITED')).toBeDefined()
    expect(within(alert).getByText('Too many requests')).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()

    await user.click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('table')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(healthGet).toHaveBeenCalledTimes(2)
  })

  test('explains an unreachable API, after one automatic retry, without leaking the raw error', async () => {
    healthGet.mockRejectedValue(new TypeError('fetch failed'))
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('NETWORK_ERROR')).toBeDefined()
    expect(within(alert).getByText('The API could not be reached.')).toBeDefined()
    expect(alert.textContent).not.toContain('fetch failed')
    expect(healthGet).toHaveBeenCalledTimes(2)
  })

  test('a degraded API (503) is retried once, then shown as an error', async () => {
    const body = { code: 'SERVICE_UNAVAILABLE', message: 'A dependency is down', status: 'degraded' }
    healthGet.mockResolvedValue(failed(503, body))
    renderPage()

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('SERVICE_UNAVAILABLE')).toBeDefined()
    await waitFor(() => expect(healthGet).toHaveBeenCalledTimes(2))
  })

  // Not a DOM test: what the server sends when the loader's prefetch failed (src/routes/index.tsx).
  test('during SSR, a failed prefetch renders the loading state and leaves the retry to the browser', async () => {
    const client = createQueryClient()
    client.setDefaultOptions({ queries: { retry: false } })
    healthGet.mockResolvedValue(failed(429, { code: 'RATE_LIMITED', message: 'Too many requests' }))
    await client.prefetchQuery(healthQueryOptions)

    const html = renderToString(
      <QueryClientProvider client={client}>
        <HealthPage />
      </QueryClientProvider>,
    )

    expect(html).toContain('aria-label="Loading API status"')
    expect(html).not.toContain('role="alert"')
  })
})

// Empty and forbidden states do not apply: /api/health is a public singleton report (no list to be empty, no
// session or permission involved), so the page has loading, success and error states only (apps/web R33).
