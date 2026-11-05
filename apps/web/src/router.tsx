import { isServer } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { installAuthFailureReactions } from '@/features/auth'
import { createQueryClient } from '@/lib/query-client'
import { routeTree } from './routeTree.gen'

// Called once per request on the server and once in the browser, so each request gets its own cache.
export function getRouter() {
  const queryClient = createQueryClient()
  // Browser only, like the session watcher it feeds: a query that failed during SSR is not sent to the browser, which
  // fetches it again and reacts then. Reacting on the server as well would refresh the same grants twice.
  if (!isServer) installAuthFailureReactions(queryClient)
  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
  })
  // Sends queries fetched during SSR to the browser and wraps the app in QueryClientProvider.
  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}
