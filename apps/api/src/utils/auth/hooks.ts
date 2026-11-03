import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { db } from '../db'
import { AUTH_MODULE } from '../logger/auth'
import { telemetry } from '../telemetry'
import { roles as acRoles } from './access'
import { readUserId } from './body'
import { isRoleName, rolesOf, SUPER_ADMIN } from './roles'
import { wouldRemoveLastSuperAdmin } from './super-admins'
import { isUserMutationLockHeld, USER_MUTATION_PATHS } from './user-mutation-lock'

// The admin-plugin endpoints listed in API.md §3.1. This is an allowlist: a Better Auth upgrade that
// adds an admin endpoint cannot open it silently (static-roles.md §7, apps/api R24).
export const ALLOWED_ADMIN_PATHS: ReadonlySet<string> = new Set([
  '/admin/list-users',
  '/admin/set-role',
  '/admin/ban-user',
  '/admin/unban-user',
  '/admin/list-user-sessions',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/remove-user',
])

// Unlisted, but allowed for server-side `auth.api` calls (no `request`): the `permission` macro
// (TASK-05) calls `auth.api.userHasPermission`. Every other unlisted path is refused there too.
const SERVER_ONLY_ADMIN_PATHS: ReadonlySet<string> = new Set(['/admin/has-permission'])

// The listed endpoints whose body names a target user (Better Auth requires `userId` on each).
const USER_ID_PATHS: ReadonlySet<string> = new Set([
  '/admin/set-role',
  '/admin/ban-user',
  '/admin/unban-user',
  '/admin/list-user-sessions',
  '/admin/revoke-user-sessions',
  '/admin/remove-user',
])

const SELF_TARGET_PATHS: ReadonlySet<string> = new Set(['/admin/ban-user', '/admin/remove-user'])

interface EndpointPermission {
  permission: Record<string, string[]>
  // The admin plugin's own 403 when the caller lacks it (ADMIN_ERROR_CODES, not exported in 1.7.15).
  denied: { code: string; message: string }
}

// The permission each endpoint checks itself (admin plugin, 1.7.15), after this hook has run.
const REQUIRED_PERMISSION: Readonly<Record<string, EndpointPermission>> = {
  '/admin/set-role': {
    permission: { user: ['set-role'] },
    denied: { code: 'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE', message: 'You are not allowed to change users role' },
  },
  '/admin/ban-user': {
    permission: { user: ['ban'] },
    denied: { code: 'YOU_ARE_NOT_ALLOWED_TO_BAN_USERS', message: 'You are not allowed to ban users' },
  },
  '/admin/unban-user': {
    permission: { user: ['ban'] },
    denied: { code: 'YOU_ARE_NOT_ALLOWED_TO_BAN_USERS', message: 'You are not allowed to ban users' },
  },
  '/admin/remove-user': {
    permission: { user: ['delete'] },
    denied: { code: 'YOU_ARE_NOT_ALLOWED_TO_DELETE_USERS', message: 'You are not allowed to delete users' },
  },
}

type GuardContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

// A single string is one role name: "admin,super_admin" is not a registry name, so it is refused
// rather than split into roles the caller did not ask for one by one.
function requestedRoles(body: unknown): string[] | undefined {
  const value: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'role') : undefined
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.map(String)
  return undefined
}

interface Actor {
  id: string
  role: string | null | undefined
}

async function signedInActor(ctx: GuardContext): Promise<Actor | undefined> {
  const session = await getSessionFromCtx(ctx)
  if (!session) return undefined
  const role: unknown = Reflect.get(session.user, 'role')
  return { id: session.user.id, role: typeof role === 'string' ? role : null }
}

// Better Auth's rule: allowed if any held role grants it. Unknown roles grant nothing (roles.ts).
export function mayCall(role: unknown, path: string): boolean {
  const required = REQUIRED_PERMISSION[path]
  if (required === undefined) return false
  const stored = typeof role === 'string' ? role : null
  return rolesOf(stored).some((name) => isRoleName(name) && acRoles[name].authorize(required.permission).success)
}

// The endpoint's own answer to a caller without its permission.
export function forbiddenFor(path: string): APIError {
  const required = REQUIRED_PERMISSION[path]
  if (required === undefined) throw new Error(`No permission is recorded for ${path}`)
  return APIError.from('FORBIDDEN', required.denied)
}

async function blockEndpoint(ctx: GuardContext): Promise<never> {
  // The 404 is the answer either way; failing to identify the caller must not turn it into a 500.
  const actorId = (await signedInActor(ctx).catch(() => undefined))?.id
  telemetry.emit(
    'audit.auth.blocked_endpoint',
    actorId === undefined ? { path: ctx.path } : { path: ctx.path, actorId },
    { module: AUTH_MODULE },
  )
  throw new APIError('NOT_FOUND', { code: 'NOT_FOUND', message: 'Not found' })
}

// Only for a caller the endpoint will let through: anyone else gets the endpoint's own 403, and
// learns nothing about who the last super_admin is.
async function assertSuperAdminRemains(actor: Actor, path: string, targetId: string): Promise<void> {
  if (!mayCall(actor.role, path)) return
  if (await wouldRemoveLastSuperAdmin(db, targetId)) {
    throw new APIError('BAD_REQUEST', { code: 'LAST_SUPER_ADMIN', message: 'At least one super_admin must remain' })
  }
}

// Better Auth `hooks.before`: the guard rules of static-roles.md §7. Errors are Better Auth
// `APIError`s, so the response keeps Better Auth's `{ code, message }` format.
export const beforeHook = createAuthMiddleware(async (ctx) => {
  const path = ctx.path
  if (!path.startsWith('/admin/')) return

  if (!ALLOWED_ADMIN_PATHS.has(path)) {
    if (ctx.request === undefined && SERVER_ONLY_ADMIN_PATHS.has(path)) return
    return blockEndpoint(ctx)
  }

  // The HTTP mount takes the lock (utils/auth/index.ts); a server-side call must take it itself.
  // Without it the last-super_admin check below is not atomic with the write, so it is a bug.
  if (USER_MUTATION_PATHS.has(path) && !isUserMutationLockHeld()) {
    throw new Error(`${path} must run inside userMutationLock.run() (utils/auth/user-mutation-lock.ts)`)
  }

  const target = readUserId(ctx.body)
  if (USER_ID_PATHS.has(path) && target === undefined) {
    throw new APIError('BAD_REQUEST', { code: 'INVALID_USER_ID', message: 'userId must be a non-empty string' })
  }

  const isSetRole = path === '/admin/set-role'
  if ((!isSetRole && !SELF_TARGET_PATHS.has(path)) || target === undefined) return

  // Without a session the endpoint itself answers 401; the guards only judge a signed-in caller.
  const actor = await signedInActor(ctx)
  if (actor === undefined) return

  if (isSetRole) {
    if (target === actor.id) {
      throw new APIError('BAD_REQUEST', { code: 'CANNOT_CHANGE_OWN_ROLE', message: 'You cannot change your own role' })
    }
    const roles = requestedRoles(ctx.body)
    if (roles !== undefined && (roles.length === 0 || !roles.every(isRoleName))) {
      throw new APIError('BAD_REQUEST', { code: 'INVALID_ROLE', message: 'Unknown role' })
    }
    if (roles !== undefined && !roles.includes(SUPER_ADMIN)) await assertSuperAdminRemains(actor, path, target)
    return
  }

  if (target === actor.id) {
    throw new APIError('BAD_REQUEST', { code: 'CANNOT_TARGET_SELF', message: 'You cannot do this to your own account' })
  }
  await assertSuperAdminRemains(actor, path, target)
})
