import { mock } from 'bun:test'
import type { AuthClientErrorBody as ClientError } from '../../helpers/api-results'
import { ok } from '../../helpers/api-results'

// Stand-ins for both API clients, registered once: every admin test file imports this module first and loads the
// feature afterwards with `await import()` (Bun links static imports before `mock.module` runs).

type ClientResult<Data> = { data: Data; error: null } | { data: null; error: ClientError }

export interface RawUser {
  id: string
  email: string
  name: string
  image: string | null
  role?: string | null
  banned: boolean | null
  banReason?: string | null
  banExpires?: string | null
  createdAt: string
  updatedAt: string
  emailVerified: boolean
}

export interface RawSessionRow {
  id: string
  token: string
  userId: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  ipAddress: string | null
  userAgent: string | null
}

export type RawSession = { user: { id: string; email: string; name: string; image: string | null }; session: { id: string; token: string; userId: string } }

export type ListUsersQuery = {
  limit?: number
  offset?: number
  sortBy?: string
  sortDirection?: 'asc' | 'desc'
  searchValue?: string
  searchField?: 'email' | 'name'
  searchOperator?: string
  filterField?: string
  filterValue?: string
  filterOperator?: string
}

export const getSession = mock<() => Promise<ClientResult<RawSession | null>>>()
export const signOut = mock<() => Promise<ClientResult<unknown>>>()
export const listUsers = mock<(input: { query: ListUsersQuery }) => Promise<ClientResult<{ users: RawUser[]; total: number }>>>()
export const setRole = mock<(input: { userId: string; role: string }) => Promise<ClientResult<unknown>>>()
export const banUser =
  mock<(input: { userId: string; banReason?: string; banExpiresIn?: number }) => Promise<ClientResult<unknown>>>()
export const unbanUser = mock<(input: { userId: string }) => Promise<ClientResult<unknown>>>()
export const listUserSessions = mock<(input: { userId: string }) => Promise<ClientResult<{ sessions: RawSessionRow[] }>>>()
export const revokeUserSession = mock<(input: { sessionToken: string }) => Promise<ClientResult<{ success: boolean }>>>()
export const revokeUserSessions = mock<(input: { userId: string }) => Promise<ClientResult<{ success: boolean }>>>()

mock.module('@/lib/auth-client', () => ({
  authClient: {
    getSession,
    signOut,
    signIn: { email: mock(), social: mock() },
    signUp: { email: mock() },
    admin: { listUsers, setRole, banUser, unbanUser, listUserSessions, revokeUserSession, revokeUserSessions },
  },
}))

export type PermissionsBody = { roles: string[]; permissions: string[] }
type EdenResult<Data> = { data: Data; error: null } | { data: null; error: { status: number; value: unknown } }

export interface CatalogueBody {
  items: { role: string; label: string; description: string; permissions: string[] }[]
}

export const permissionsGet = mock<() => Promise<EdenResult<PermissionsBody>>>()
export const rolesGet = mock<() => Promise<EdenResult<CatalogueBody>>>()

// `health` answers too, because the real route tree mounts the status page at `/`.
const healthGet = async () => ({ data: { status: 'ok', db: 'up', redis: 'up', logStore: 'up', uptime: 1 }, error: null })

mock.module('@/lib/api', () => ({
  api: { me: { permissions: { get: permissionsGet } }, health: { get: healthGet }, admin: { roles: { get: rolesGet } } },
}))

export { apiFailed, authFailed as failed, ok } from '../../helpers/api-results'

// The compiled default matrix (static-roles.md §5), as GET /api/me/permissions answers it.
export const SUPER_ADMIN_ACCESS: PermissionsBody = {
  roles: ['super_admin'],
  permissions: [
    'posts:manage_all',
    'posts:read',
    'posts:write',
    'role:read',
    'session:delete',
    'session:list',
    'session:revoke',
    'user:ban',
    'user:create',
    'user:delete',
    'user:get',
    'user:list',
    'user:set-password',
    'user:set-role',
    'user:update',
  ],
}
export const ADMIN_ACCESS: PermissionsBody = {
  roles: ['admin'],
  permissions: ['posts:manage_all', 'posts:read', 'posts:write', 'role:read', 'session:list', 'user:get', 'user:list'],
}
export const USER_ACCESS: PermissionsBody = { roles: ['user'], permissions: ['posts:read', 'posts:write'] }

export const CATALOGUE: CatalogueBody = {
  items: [
    { role: 'super_admin', label: 'Super Admin', description: 'Full access, including roles and bans.', permissions: SUPER_ADMIN_ACCESS.permissions },
    { role: 'admin', label: 'Admin', description: 'Manages all content; reads users and sessions.', permissions: ADMIN_ACCESS.permissions },
    { role: 'user', label: 'User', description: 'Default role for every new account.', permissions: USER_ACCESS.permissions },
  ],
}

export function rawUser(overrides: Partial<RawUser> & Pick<RawUser, 'id' | 'email'>): RawUser {
  return {
    name: overrides.email.split('@')[0] ?? 'user',
    image: null,
    role: 'user',
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: '2026-10-01T08:30:00.000Z',
    updatedAt: '2026-10-01T08:30:00.000Z',
    emailVerified: true,
    ...overrides,
  }
}

export const ROOT = rawUser({ id: 'usr_root', email: 'root@example.test', name: 'Root', role: 'super_admin' })
export const ADA = rawUser({ id: 'usr_ada', email: 'ada@example.test', name: 'Ada', role: 'admin' })
export const CARL = rawUser({ id: 'usr_carl', email: 'carl@example.test', name: 'Carl', role: 'user' })

export function sessionOf(user: RawUser): RawSession {
  return {
    user: { id: user.id, email: user.email, name: user.name, image: null },
    session: { id: `ses_${user.id}`, token: `token-${user.id}`, userId: user.id },
  }
}

export function sessionRow(id: string, userId: string, createdAt = '2026-11-01T10:00:00.000Z'): RawSessionRow {
  return {
    id,
    token: `secret-${id}`,
    userId,
    createdAt,
    updatedAt: createdAt,
    expiresAt: '2026-11-08T10:00:00.000Z',
    ipAddress: '198.18.0.10',
    userAgent: 'Mozilla/5.0 test',
  }
}

// `list-users` as the API answers it: the id filter returns that one user, otherwise every user given.
export function serveUsers(users: () => RawUser[]) {
  listUsers.mockImplementation(async ({ query }) => {
    const all = users()
    if (query.filterField === 'id') {
      const match = all.filter((user) => user.id === query.filterValue)
      return ok({ users: match, total: match.length })
    }
    return ok({ users: all, total: all.length })
  })
}

export function resetAdminMocks() {
  for (const fn of [
    getSession,
    signOut,
    listUsers,
    setRole,
    banUser,
    unbanUser,
    listUserSessions,
    revokeUserSession,
    revokeUserSessions,
    permissionsGet,
    rolesGet,
  ]) {
    fn.mockReset()
  }
}

// Signed in as `user` with `access`, the catalogue answering.
export function signInAs(user: RawUser, access: PermissionsBody) {
  getSession.mockResolvedValue(ok(sessionOf(user)))
  permissionsGet.mockResolvedValue(ok(access))
  rolesGet.mockResolvedValue(ok(CATALOGUE))
}
