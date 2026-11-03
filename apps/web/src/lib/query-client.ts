import { QueryClient } from '@tanstack/react-query'
import { ApiError } from './api-error'

const MAX_RETRIES = 1

// A 4xx will not change on retry (bad input, no session, no permission). Network failures and 5xx might.
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false
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
