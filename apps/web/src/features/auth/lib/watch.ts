import type { QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/lib/api-error'
import { authKeys } from './keys'
import { dropOtherQueries, isSessionQuery, type AuthSession } from './session'

interface Invalidates {
  invalidate(): Promise<unknown>
}

const SESSION_KEY = authKeys.session()
function userIdOf(session: AuthSession | null | undefined): string | null | undefined {
  return session === undefined ? undefined : (session?.user.id ?? null)
}

// Reacts to identity changes this tab did not make: a sign-in or sign-out in another tab (seen on refetch), an
// expired or revoked session, a ban. Local changes go through `switchIdentity` and are written with
// `setQueryData`, which this skips. Returns the unsubscribe function.
export function watchSession(queryClient: QueryClient, router: Invalidates): () => void {
  let known = userIdOf(queryClient.getQueryData<AuthSession | null>(SESSION_KEY))

  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated') return
    const { action, query } = event

    if (isSessionQuery(query)) {
      if (action.type !== 'success') return
      const next = userIdOf(action.data as AuthSession | null)
      const previous = known
      known = next
      if (action.manual || previous === undefined || previous === next) return
      // Another identity, or none: nothing cached for the old one may be shown, permissions included.
      dropOtherQueries(queryClient)
      void router.invalidate()
      return
    }

    // The API saw no session on a call made with one (apps/web: expired session → /login). Re-reading the session
    // turns that into the change above.
    if (action.type === 'error' && action.error instanceof ApiError && action.error.status === 401) {
      void queryClient.invalidateQueries({ queryKey: SESSION_KEY, exact: true })
    }
  })
}
