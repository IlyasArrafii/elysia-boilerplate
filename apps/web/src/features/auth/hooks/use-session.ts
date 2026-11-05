import { queryOptions, useQuery } from '@tanstack/react-query'
import { callAuthClient } from '@/lib/api-error'
import { authClient } from '@/lib/auth-client'
import { authKeys } from '../lib/keys'
import { toAuthSession, type AuthSession } from '../lib/session'

// GET /api/auth/get-session. During SSR the auth client forwards the visitor's cookie (src/lib/auth-client.ts),
// so this reads the session of the request being rendered. `null` is a guest.
export async function fetchSession(): Promise<AuthSession | null> {
  const data = await callAuthClient(() => authClient.getSession())
  return data ? toAuthSession(data) : null
}

// Shared by route guards (`fetchQuery`) and `useSession()`. Retried by the app's query defaults: a 4xx will not change
// on retry, a network failure or a 5xx (session store briefly down) might.
export const sessionQueryOptions = queryOptions({
  queryKey: authKeys.session(),
  queryFn: fetchSession,
})

// The current session, app-wide (F-05). PostgreSQL decides; this is a cached read of its answer.
export function useSession() {
  return useQuery(sessionQueryOptions)
}
