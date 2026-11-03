import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { createQueryClient } from '@/lib/query-client'
import { routeTree } from './routeTree.gen'

// Called once per request on the server and once in the browser, so each request gets its own cache.
export function getRouter() {
  const queryClient = createQueryClient()
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
  })
  // Sends queries fetched during SSR to the browser and wraps the app in QueryClientProvider.
  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}
