import { describe, expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { healthQueryOptions } from '../../src/features/health'
import { createQueryClient } from '../../src/lib/query-client'
import { Route } from '../../src/routes/index'
import { renderWithRouter, screen } from '../helpers/render'

describe('/ (home)', () => {
  test('is the API status page, rendering what the loader put in the cache', async () => {
    const Home = Route.options.component
    if (Home === undefined) throw new Error('the / route has no component')
    // Stands in for the loader's prefetch; fresh data (staleTime) means the page does not fetch on mount.
    const queryClient = createQueryClient()
    queryClient.setQueryData(healthQueryOptions.queryKey, {
      status: 'ok',
      db: 'up',
      redis: 'up',
      logStore: 'up',
      uptime: 1,
    })

    await renderWithRouter(() => (
      <QueryClientProvider client={queryClient}>
        <Home />
      </QueryClientProvider>
    ))

    expect(screen.getByRole('heading', { level: 1, name: 'API status' })).toBeDefined()
    expect(screen.getByRole('heading', { level: 2, name: 'Dependencies' })).toBeDefined()
  })
})
