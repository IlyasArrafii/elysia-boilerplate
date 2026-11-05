import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api-error'

const MAX_RETRIES = 1

// An HTTP answer below 500 will not change on retry (bad input, no session, no permission, a refused redirect).
// Network failures and 5xx might. Every query uses this, the session check included.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && !error.network && error.status < 500) return false
  return failureCount < MAX_RETRIES
}

// One QueryClient per request on the server and one per tab in the browser (created in router.tsx).
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Data fetched during SSR is not refetched the moment the page hydrates.
        staleTime: 30_000,
        retry: shouldRetry,
      },
    },
  })
}
