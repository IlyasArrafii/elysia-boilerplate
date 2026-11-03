import { Elysia, status, type AnyElysia, type Context } from 'elysia'
import { getRequestContext } from '../logger/context'
import { isPermission, type Permission } from './access'
import { auth } from './auth'
import { rolesOf, type RoleName } from './roles'

// API.md §1. Thrown as `status(...)`, so the error handler keeps them and logs one `http.error`.
export const UNAUTHORIZED = { code: 'UNAUTHORIZED', message: 'Sign in to continue' } as const
export const FORBIDDEN = { code: 'FORBIDDEN', message: 'You do not have permission to do this' } as const

// `posts:read` → `{ posts: ['read'] }`, the shape Better Auth checks. Runs when the route is declared,
// so a string that is not in the merged statement (a cast, an action since removed) fails startup.
export function permissionCheck(permission: Permission): Record<string, string[]> {
  if (!isPermission(permission)) {
    throw new Error(`Unknown permission "${String(permission)}": declare it in a module's permissions.ts`)
  }
  const separator = permission.indexOf(':')
  return { [permission.slice(0, separator)]: [permission.slice(separator + 1)] }
}

function setCookiesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((cookie): cookie is string => typeof cookie === 'string') : []
}

// The session is read from PostgreSQL on every call (DEC-054): no cookie cache, no Redis copy, so a
// revoked session or a new role applies on the next request. A failing store is Better Auth's error,
// answered 500 by the error handler, never mistaken for "signed out".
async function resolveSession({ request, set }: Pick<Context, 'request' | 'set'>) {
  const { headers, response: session } = await auth.api.getSession({ headers: request.headers, returnHeaders: true })
  // A refreshed expiry (`updateAge`) or a cleared stale cookie, exactly as `/api/auth/get-session` sends it.
  // Appended, so a cookie an earlier hook set is kept.
  const cookies = headers.getSetCookie()
  if (cookies.length > 0) set.headers['set-cookie'] = [...setCookiesOf(set.headers['set-cookie']), ...cookies]

  if (session === null) throw status(401, UNAUTHORIZED)

  const context = getRequestContext()
  if (context !== undefined) context.userId = session.user.id
  return { user: session.user, session: session.session }
}

// Better Auth's own check (admin plugin `has-permission`, server-side only: hooks.ts). The role comes
// from the user just read with the session, read the way Better Auth reads it (`rolesOf`): NULL is
// `user`, unknown roles grant nothing, and any held role that grants the permission is enough.
async function authorize(role: string | null | undefined, permissions: Record<string, string[]>): Promise<void> {
  // Better Auth 1.7.15 types `role` as one registry name, but validates a string and splits it on
  // commas, which is how several roles ("admin,editor") are stored.
  const stored = rolesOf(role).join(',') as RoleName
  const { success } = await auth.api.userHasPermission({ body: { role: stored, permissions } })
  if (!success) throw status(403, FORBIDDEN)
}

// Every resolver the two options add, so `assertRouteAccess` can tell a protected route by its hooks.
const accessResolvers = new WeakSet<object>([resolveSession])

// One permission per route; it implies a session, so 401 comes before 403. It resolves the session
// itself rather than nesting `auth: true`: Elysia 1.4.30 does not type a nested macro's `user` in
// the outer macro's hooks.
function permissionResolver(permission: Permission) {
  const permissions = permissionCheck(permission)
  const resolve = async (context: Pick<Context, 'request' | 'set'>) => {
    const resolved = await resolveSession(context)
    await authorize(resolved.user.role, permissions)
    return resolved
  }
  accessResolvers.add(resolve)
  return resolve
}

// The `auth` and `permission` route options (DEC-010). Modules `.use(authGuard)`, never `authPlugin`:
// using that inside a module would mount Better Auth's `/auth/*` again under the module's prefix.
// A route takes one of the two: `permission` already requires the session.
export const authGuard = new Elysia({ name: 'auth-guard' }).macro({
  auth: { resolve: resolveSession },
  permission: (permission: Permission) => ({ resolve: permissionResolver(permission) }),
})

export interface PublicRoute {
  method: string
  // As Elysia registers it: a module's `GET /` ends in a slash.
  path: string
}

// The routes API.md marks Public (R20). Every other route must declare `auth: true` or `permission`.
export const PUBLIC_ROUTES: readonly PublicRoute[] = [
  // Better Auth's handler: each of its endpoints decides about the session itself (API.md §3.1).
  { method: 'ALL', path: '/api/auth/*' },
  { method: 'GET', path: '/api/health/' },
]

// Elysia 1.4.30 keeps a macro's `resolve` in the route's `beforeHandle` list as `{ fn, subType }`.
// If a later version stores it differently, this finds nothing and every protected route fails
// startup: the check fails closed.
function runsAccessResolver(hooks: unknown): boolean {
  const handlers: unknown = typeof hooks === 'object' && hooks !== null ? Reflect.get(hooks, 'beforeHandle') : undefined
  const list: unknown[] = Array.isArray(handlers) ? handlers : [handlers]
  return list.some((handler) => {
    if (typeof handler === 'function') return accessResolvers.has(handler)
    const fn: unknown = typeof handler === 'object' && handler !== null ? Reflect.get(handler, 'fn') : undefined
    return typeof fn === 'function' && accessResolvers.has(fn)
  })
}

// Default deny (DEC-010): the app does not start while a route is neither protected nor documented
// Public. `auth: false`, or a forgotten option, is caught here rather than shipped open. Returns the
// app unchanged so Eden keeps its types.
export function assertRouteAccess<const T extends AnyElysia>(app: T, publicRoutes: readonly PublicRoute[] = PUBLIC_ROUTES): T {
  const undeclared = app.routes
    .filter((route) => !runsAccessResolver(route.hooks))
    .filter((route) => !publicRoutes.some((open) => open.method === route.method && open.path === route.path))
    .map((route) => `${route.method} ${route.path}`)

  if (undeclared.length > 0) {
    throw new Error(
      `${undeclared.join(', ')}: declare \`auth: true\` or \`permission\`, or list the route as Public in API.md and PUBLIC_ROUTES (default deny, DEC-010)`,
    )
  }
  return app
}
