import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createQueryClient } from '@/lib/query-client'
import { routeTree } from '@/routeTree.gen'
import { Route as rootRoute } from '@/routes/__root'

// The real root renders the whole HTML document (<html>, stylesheet links), which cannot live inside a test container:
// the shell is swapped for a pass-through. Everything below it (app shell, guards, pages) is the real app.
Object.assign(rootRoute.options, { shellComponent: ({ children }: { children: ReactNode }) => children, head: undefined })

// The app's real QueryClient defaults, minus the back-off wait.
export function testQueryClient(): QueryClient {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } })
  return client
}

export function createTestRouter(path: string, queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
    Wrap: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  })
}

export type TestRouter = ReturnType<typeof createTestRouter>

export interface RenderAppResult extends RenderResult {
  router: TestRouter
  queryClient: QueryClient
}

// The whole app (real route tree: guards, pages, app shell) on an in-memory history. Import this module with
// `await import()` after `./api-mock`, so the route tree loads against the mocked clients.
export async function renderApp(path: string, queryClient = testQueryClient()): Promise<RenderAppResult> {
  const router = createTestRouter(path, queryClient)
  await router.load()
  const result = render(<RouterProvider router={router} />)
  return { ...result, router, queryClient }
}

// The URL the router ended up at, as the address bar would show it.
export function currentHref(router: TestRouter): string {
  return router.state.location.href
}
