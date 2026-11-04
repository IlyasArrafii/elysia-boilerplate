import { queryOptions, useQuery } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'
import { AuthError, networkError, toAuthError } from '../lib/errors'
import { authKeys } from '../lib/keys'
import { toAuthSession, type AuthSession } from '../lib/session'

const MAX_RETRIES = 1

// A 4xx will not change on retry; a network failure or a 5xx (session store briefly down) might.
function retrySession(failureCount: number, error: unknown): boolean {
  if (error instanceof AuthError && error.status >= 400 && error.status < 500) return false
  return failureCount < MAX_RETRIES
}

// GET /api/auth/get-session. During SSR the auth client forwards the visitor's cookie (src/lib/auth-client.ts),
// so this reads the session of the request being rendered. `null` is a guest.
export async function fetchSession(): Promise<AuthSession | null> {
  let result: Awaited<ReturnType<typeof authClient.getSession>>
  try {
    result = await authClient.getSession()
  } catch (cause) {
    throw networkError(cause)
  }
  if (result.error) throw toAuthError(result.error)
  return result.data ? toAuthSession(result.data) : null
}

// Shared by route guards (`fetchQuery`) and `useSession()`.
export const sessionQueryOptions = queryOptions({
  queryKey: authKeys.session(),
  queryFn: fetchSession,
  retry: retrySession,
})

// The current session, app-wide (F-05). PostgreSQL decides; this is a cached read of its answer.
export function useSession() {
  return useQuery(sessionQueryOptions)
}
