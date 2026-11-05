import { hashKey, type Query, type QueryClient } from '@tanstack/react-query'
import { authKeys } from './keys'

const SESSION_HASH = hashKey(authKeys.session())

export function isSessionQuery(query: Query): boolean {
  return query.queryHash === SESSION_HASH
}

// The signed-in user the cache holds, if any.
export function cachedUserId(queryClient: QueryClient): string | undefined {
  return queryClient.getQueryData<AuthSession | null>(authKeys.session())?.user.id
}

// Asks the API for the session again. If it ended, the session watcher (`watchSession`) drops the cache and the guards
// send the page to /login. Resolves even when the re-read fails (TanStack Query swallows refetch errors here).
export function recheckSession(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: authKeys.session(), exact: true })
}

// Everything cached except the session query itself. That one is updated in place instead, because removing it
// would detach the components already subscribed to it (the header would keep showing the old identity).
export function dropOtherQueries(queryClient: QueryClient) {
  queryClient.removeQueries({ predicate: (query) => !isSessionQuery(query) })
}

export interface SessionUser {
  id: string
  email: string
  name: string
  image: string | null
}

// The session as the UI sees it. Deliberately not Better Auth's raw `{ user, session }`: that holds the session
// token, and whatever the session query returns during SSR is serialised into the page's HTML.
export interface AuthSession {
  user: SessionUser
}

interface RawSession {
  user: { id: string; email: string; name: string; image?: string | null }
}

export function toAuthSession(raw: RawSession): AuthSession {
  const { id, email, name, image } = raw.user
  return { user: { id, email, name, image: image ?? null } }
}

interface Invalidates {
  invalidate(): Promise<unknown>
}

// The one way the signed-in identity changes from this tab (sign-in, sign-up, sign-out). Nothing cached for the
// previous identity survives (apps/web R19), then every active route re-runs its `beforeLoad`: guest pages send a
// new session to its destination, protected pages send a signed-out visitor to /login.
export async function switchIdentity(queryClient: QueryClient, router: Invalidates, session: AuthSession | null) {
  await queryClient.cancelQueries()
  dropOtherQueries(queryClient)
  queryClient.setQueryData(authKeys.session(), session)
  await router.invalidate()
}
