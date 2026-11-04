import type { QueryClient } from '@tanstack/react-query'
import { redirect, type ParsedLocation } from '@tanstack/react-router'
import { permissionsQueryOptions, type Permission } from '../hooks/use-permissions'
import { sessionQueryOptions } from '../hooks/use-session'
import { safeRedirect } from './redirect'
import type { AuthSession } from './session'

// Route guards for `beforeLoad` (apps/web R2). They run on the server for the first page load and in the browser on
// client navigation, and only decide what to show: the API decides access.

interface GuardContext {
  queryClient: QueryClient
}

export interface LoginSearch {
  redirect?: string
  error?: string
}

// The `?notice=` value the app shell turns into a message after a permission redirect.
export const FORBIDDEN_NOTICE = 'forbidden'

// `validateSearch` for /login and /register: an unsafe `redirect` is left out of the typed search. The router still
// merges raw params into what `useSearch` returns, so every reader passes the value through `safeRedirect` again.
export function validateLoginSearch(search: Record<string, unknown>): LoginSearch {
  const result: LoginSearch = {}
  if (typeof search.redirect === 'string' && safeRedirect(search.redirect) === search.redirect) result.redirect = search.redirect
  if (typeof search.error === 'string') result.error = search.error
  return result
}

// Protected routes: a guest goes to /login, which brings them back here after signing in. The session is fetched
// unless a fresh copy is cached, and a failure to check it throws to the route's error component: never let through.
export async function requireSession({
  context,
  location,
}: {
  context: GuardContext
  location: ParsedLocation
}): Promise<{ session: AuthSession }> {
  const session = await context.queryClient.fetchQuery(sessionQueryOptions)
  if (!session) throw redirect({ to: '/login', search: { redirect: location.href } })
  return { session }
}

// /login and /register: a signed-in user goes where they were headed. If the session cannot be checked, the form is
// shown; a guest page protects nothing.
export async function redirectSignedIn({ context, search }: { context: GuardContext; search: LoginSearch }) {
  const session = await context.queryClient.fetchQuery(sessionQueryOptions).catch(() => null)
  if (session) throw redirect({ href: safeRedirect(search.redirect) })
}

// A page that needs a permission, after `requireSession`: without it, back to / with a message (apps/web R2).
export async function requirePermission(queryClient: QueryClient, session: AuthSession, permission: Permission) {
  const access = await queryClient.fetchQuery(permissionsQueryOptions(session.user.id))
  if (!access.permissions.includes(permission)) throw redirect({ href: `/?notice=${FORBIDDEN_NOTICE}` })
}
