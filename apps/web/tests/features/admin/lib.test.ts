import { describe, expect, test } from 'bun:test'
import { adminErrorView, callAdmin, localError, SESSION_NOT_FOUND, USER_CHANGED } from '@/features/admin/lib/errors'
import { deniedAdminKeys } from '@/features/admin/lib/guards'
import { adminKeys } from '@/features/admin/lib/keys'
import { toAdminSessions } from '@/features/admin/lib/sessions'
import {
  formatDateTime,
  listUsersQuery,
  rolesOf,
  toAdminUser,
  toUsersPage,
  userByIdQuery,
  USERS_PAGE_SIZE,
  validateUsersSearch,
} from '@/features/admin/lib/users'
import { roleChangeProblem, toBanBody } from '@/features/admin/lib/validation'
import { ApiError, fromAuthClient, NETWORK_ERROR, networkError, UNKNOWN_ERROR } from '@/lib/api-error'

describe('rolesOf (read like Better Auth 1.7.15)', () => {
  test.each([
    [null, ['user']],
    [undefined, ['user']],
    ['', ['user']],
    ['admin', ['admin']],
    ['admin,editor', ['admin', 'editor']],
    // Nothing is trimmed: " super_admin" is an unknown role, not super_admin.
    ['admin, super_admin', ['admin', ' super_admin']],
  ])('%p → %p', (stored, roles) => {
    expect(rolesOf(stored)).toEqual(roles)
  })
})

describe('toAdminUser', () => {
  const base = { id: 'usr_1', email: 'a@example.test', name: 'A', createdAt: new Date('2026-10-01T08:30:00Z') }

  test('maps dates to ISO strings and a missing role to user', () => {
    expect(toAdminUser({ ...base, role: null, banned: null })).toEqual({
      id: 'usr_1',
      email: 'a@example.test',
      name: 'A',
      roles: ['user'],
      banned: false,
      banReason: null,
      banExpires: null,
      createdAt: '2026-10-01T08:30:00.000Z',
    })
  })

  test('keeps ban details only while banned', () => {
    const banned = toAdminUser({ ...base, banned: true, banReason: 'spam', banExpires: '2026-12-01T00:00:00Z' })
    expect(banned).toMatchObject({ banned: true, banReason: 'spam', banExpires: '2026-12-01T00:00:00.000Z' })
    const lifted = toAdminUser({ ...base, banned: false, banReason: 'old', banExpires: '2026-12-01T00:00:00Z' })
    expect(lifted).toMatchObject({ banned: false, banReason: null, banExpires: null })
  })
})

describe('users list query', () => {
  test('validateUsersSearch keeps a whole page above 1 and a non-empty trimmed search', () => {
    expect(validateUsersSearch({ page: '3', q: '  ada  ' })).toEqual({ page: 3, q: 'ada' })
    expect(validateUsersSearch({ page: 2 })).toEqual({ page: 2 })
    for (const page of ['0', '1', '-2', '1.5', 'x', '9007199254740993']) expect(validateUsersSearch({ page })).toEqual({})
    expect(validateUsersSearch({ q: '   ' })).toEqual({})
    expect(validateUsersSearch({ q: ['a'] })).toEqual({})
  })

  test('listUsersQuery pages newest first and searches emails', () => {
    expect(listUsersQuery({})).toEqual({ limit: USERS_PAGE_SIZE, offset: 0, sortBy: 'createdAt', sortDirection: 'desc' })
    expect(listUsersQuery({ page: 3, q: 'ada' })).toEqual({
      limit: USERS_PAGE_SIZE,
      offset: 2 * USERS_PAGE_SIZE,
      sortBy: 'createdAt',
      sortDirection: 'desc',
      searchValue: 'ada',
      searchField: 'email',
      searchOperator: 'contains',
    })
  })

  test('the detail filters list-users on the id (get-user is not allowed by the API)', () => {
    expect(userByIdQuery('usr_1')).toEqual({ filterField: 'id', filterValue: 'usr_1', filterOperator: 'eq', limit: 1 })
  })

  test('toUsersPage counts pages, at least one', () => {
    expect(toUsersPage({ users: [], total: 0 }, 1)).toMatchObject({ total: 0, page: 1, totalPages: 1 })
    expect(toUsersPage({ users: [], total: USERS_PAGE_SIZE + 1 }, 2)).toMatchObject({ page: 2, totalPages: 2 })
  })
})

test('formatDateTime does not depend on the machine time zone', () => {
  expect(formatDateTime('2026-10-01T08:30:00.000Z')).toBe('2026-10-01 08:30 UTC')
  expect(formatDateTime(null)).toBe('—')
})

test('toAdminSessions puts the newest session first', () => {
  const row = (id: string, createdAt: string) => ({ id, token: `t-${id}`, createdAt, expiresAt: createdAt, ipAddress: '', userAgent: null })
  const sessions = toAdminSessions({ sessions: [row('old', '2026-11-01T00:00:00Z'), row('new', '2026-11-02T00:00:00Z')] })
  expect(sessions.map((session) => session.id)).toEqual(['new', 'old'])
  expect(sessions[0]?.ipAddress).toBeNull()
  // Tokens are dropped before anything is cached or shown.
  expect(JSON.stringify(sessions)).not.toContain('t-new')
})

describe('deniedAdminKeys', () => {
  const only = (...granted: string[]) => (permission: string) => granted.includes(permission)

  test('nothing for super_admin or the read-only admin', () => {
    expect(deniedAdminKeys(only('user:list', 'user:get', 'session:list', 'role:read'))).toEqual([])
  })
  test('everything for a plain user', () => {
    expect(deniedAdminKeys(only())).toEqual([adminKeys.users(), adminKeys.allSessions(), adminKeys.roles()])
  })
  test('only the details without user:get', () => {
    expect(deniedAdminKeys(only('user:list', 'session:list', 'role:read'))).toEqual([adminKeys.userDetails()])
  })
})

test('query keys all start with admin and separate users, details and sessions', () => {
  expect(adminKeys.userList({ page: 2 })).toEqual(['admin', 'users', 'list', { page: 2 }])
  expect(adminKeys.user('usr_1')).toEqual(['admin', 'users', 'detail', 'usr_1'])
  expect(adminKeys.sessions('usr_1')).toEqual(['admin', 'sessions', 'usr_1'])
  expect(adminKeys.roles()).toEqual(['admin', 'roles'])
})

describe('ban body', () => {
  test('leaves out an empty reason and an unlimited length', () => {
    expect(toBanBody({ reason: '   ', duration: 'never' })).toEqual({})
  })
  test('trims the reason and sends the length in seconds', () => {
    expect(toBanBody({ reason: ' spam ', duration: '1d' })).toEqual({ banReason: 'spam', banExpiresIn: 86_400 })
  })
})

describe('roleChangeProblem', () => {
  const input = { targetId: 'usr_b', currentUserId: 'usr_a', currentRoles: ['user'], nextRole: 'admin', catalogue: ['super_admin', 'admin', 'user'] }

  test('a different registry role for someone else is allowed', () => expect(roleChangeProblem(input)).toBeNull())
  test('own account is refused first', () => expect(roleChangeProblem({ ...input, targetId: 'usr_a' })).toBe('own-account'))
  test('the same single role is unchanged', () => expect(roleChangeProblem({ ...input, nextRole: 'user' })).toBe('unchanged'))
  test('mixed roles replaced by one of them is a change', () => {
    expect(roleChangeProblem({ ...input, currentRoles: ['admin', 'editor'], nextRole: 'admin' })).toBeNull()
  })
  test('a role outside the catalogue is refused', () => expect(roleChangeProblem({ ...input, nextRole: 'root' })).toBe('unknown-role'))
})

describe('errors', () => {
  test('callAdmin returns data, throws the error, a network failure and an empty success', async () => {
    expect(await callAdmin(async () => ({ data: 1, error: null }))).toBe(1)
    await expect(callAdmin(async () => ({ data: null, error: { status: 403, code: 'YOU_ARE_NOT_ALLOWED_TO_BAN_USERS' } }))).rejects.toMatchObject({
      status: 403,
      code: 'YOU_ARE_NOT_ALLOWED_TO_BAN_USERS',
    })
    await expect(
      callAdmin(async () => {
        throw new TypeError('fetch failed')
      }),
    ).rejects.toMatchObject({ name: 'ApiError', network: true, code: NETWORK_ERROR })
    await expect(callAdmin(async () => ({ data: null, error: null }))).rejects.toMatchObject({ status: 500, code: UNKNOWN_ERROR })
  })

  test.each([
    ['CANNOT_CHANGE_OWN_ROLE', 400, 'set-role', 'You cannot change your own role. Nothing was changed.'],
    ['LAST_SUPER_ADMIN', 400, 'ban', 'At least one usable super_admin must remain, so the API refused this change. Nothing was changed.'],
    ['USER_MUTATION_BUSY', 503, 'unban', 'Another account change is in progress. Nothing was changed; try again in a moment.'],
    [USER_CHANGED, 409, 'set-role', 'This user changed since the page loaded. Nothing was changed; review the current values and try again.'],
    [SESSION_NOT_FOUND, 404, 'revoke-session', 'This session had already ended. The list has been refreshed.'],
  ] as const)('%s is shown with its own message', (code, status, action, message) => {
    expect(adminErrorView(new ApiError(status, code, 'raw'), action)).toEqual({ code, message })
  })

  // The API sends CANNOT_TARGET_SELF for any change aimed at the caller's own account, not only a ban.
  test.each([
    ['ban', 'You cannot ban yourself. Nothing was changed.'],
    ['set-role', 'You cannot change your own role. Nothing was changed.'],
    ['unban', 'You cannot do this to your own account. Nothing was changed.'],
    ['revoke-sessions', 'You cannot do this to your own account. Nothing was changed.'],
  ] as const)('CANNOT_TARGET_SELF on %s names that action, or none', (action, message) => {
    expect(adminErrorView(new ApiError(400, 'CANNOT_TARGET_SELF', 'raw'), action)).toEqual({ code: 'CANNOT_TARGET_SELF', message })
  })

  test('a network failure is a NETWORK_ERROR', () => {
    const error = networkError(new TypeError('fetch failed'), 'auth')
    expect(adminErrorView(error, 'users')).toEqual({ code: NETWORK_ERROR, message: 'The API could not be reached. Check your connection and try again.' })
  })

  test('a Better Auth failure without a code is labelled by its status, as before', () => {
    expect(adminErrorView(fromAuthClient({ status: 401 }), 'users')).toEqual({
      code: 'UNAUTHORIZED',
      message: 'Your session has ended. Sign in again to continue.',
    })
    expect(adminErrorView(fromAuthClient({ status: 403 }), 'ban').code).toBe('FORBIDDEN')
    expect(adminErrorView(fromAuthClient({ status: 429 }), 'ban')).toEqual({ code: UNKNOWN_ERROR, message: 'The user could not be banned. Try again.' })
    expect(adminErrorView(localError(500, UNKNOWN_ERROR), 'roles').code).toBe(UNKNOWN_ERROR)
  })

  test('401 and 403 without a known code, a 5xx and a non-API error', () => {
    expect(adminErrorView(new ApiError(401, 'UNAUTHORIZED', 'x'), 'users').message).toBe('Your session has ended. Sign in again to continue.')
    expect(adminErrorView(new ApiError(403, 'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE', 'x'), 'set-role')).toEqual({
      code: 'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE',
      message: 'Your role does not allow this action. Nothing was changed; your access has been refreshed.',
    })
    expect(adminErrorView(new ApiError(500, 'INTERNAL_ERROR', 'x'), 'roles')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'The role catalogue could not be loaded. Try again.',
    })
    expect(adminErrorView(new Error('boom'), 'revoke-sessions')).toEqual({
      code: UNKNOWN_ERROR,
      message: 'The sessions could not be revoked. Try again.',
    })
  })
})
