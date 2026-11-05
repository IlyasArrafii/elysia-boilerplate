import { partialMatchKey, type Query, type QueryClient } from '@tanstack/react-query'
import { ApiError } from '@/lib/api-error'
import { authKeys } from './keys'
import { cachedUserId, isSessionQuery, recheckSession } from './session'

// A permissions query refused with 403 must not refresh itself: that would ask again for ever.
function isPermissionsQuery(query: Query): boolean {
  return partialMatchKey(query.queryKey, authKeys.allPermissions())
}

function react(queryClient: QueryClient, error: unknown, query?: Query) {
  if (!(error instanceof ApiError)) return
  // Only a call made with a session says something new. Without one, a 401 or 403 is the answer itself (a rejected
  // sign-in, a banned account) and there is no one whose permissions could be stale.
  const userId = cachedUserId(queryClient)
  if (userId === undefined) return
  // The API saw no session: re-reading it lets the session watcher send the visitor to /login.
  if (error.status === 401) void recheckSession(queryClient)
  // The UI offered something the API refused: the cached grants are stale (role changed), so `can()` must hear it.
  if (error.status === 403 && !(query && isPermissionsQuery(query))) {
    void queryClient.invalidateQueries({ queryKey: authKeys.permissions(userId), exact: true })
  }
}

// The app's one reaction to a 401 or 403 from any query or mutation, whatever the feature or client. Install it once
// per QueryClient (router.tsx); features never re-implement it. Returns the unsubscribe function.
export function installAuthFailureReactions(queryClient: QueryClient): () => void {
  const stopQueries = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'error') return
    // The session query's own failures are what the session watcher and the guards handle.
    if (isSessionQuery(event.query)) return
    react(queryClient, event.action.error, event.query)
  })
  // Not a cache subscription: a mutation's `error` event fires only after its own `onSettled` has finished, and admin
  // hooks await a refetch there. The cache-level `onError` runs first, as soon as the mutation fails.
  const mutationCache = queryClient.getMutationCache()
  const previous = mutationCache.config
  mutationCache.config = {
    ...previous,
    onError: (error, ...rest) => {
      react(queryClient, error)
      return previous.onError?.(error, ...rest)
    },
  }
  return () => {
    stopQueries()
    mutationCache.config = previous
  }
}
