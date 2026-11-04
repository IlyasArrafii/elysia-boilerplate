import {
  ADA,
  ADMIN_ACCESS,
  CARL,
  failed,
  getSession,
  listUsers,
  ok,
  resetAdminMocks,
  revokeUserSession,
  ROOT,
  serveUsers,
  sessionOf,
  sessionRow,
  listUserSessions,
  setRole,
  signInAs,
  SUPER_ADMIN_ACCESS,
} from './api-mock'
import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { AuthSession } from '@/features/auth'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ApiError } from '@/lib/api-error'

const { useRevokeSession, useSetRole } = await import('@/features/admin/hooks/use-admin-actions')
const { useUser, useUsers, usersQueryOptions } = await import('@/features/admin/hooks/use-users')
const { useUserSessions } = await import('@/features/admin/hooks/use-user-sessions')
const { AdminNetworkError } = await import('@/features/admin/lib/errors')
const { useRoles } = await import('@/features/admin/hooks/use-roles')
const { permissionsQueryOptions, sessionQueryOptions } = await import('@/features/auth')
const { testQueryClient } = await import('../auth/app')

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

// The signed-in user is known before the hook runs, as on an admin page.
function signedInClient() {
  const queryClient = testQueryClient()
  const session: AuthSession = { user: { id: ROOT.id, email: ROOT.email, name: ROOT.name, image: null } }
  queryClient.setQueryData(sessionQueryOptions.queryKey, session)
  return queryClient
}

// The `queryKey` of each `invalidateQueries` call, in order.
function invalidatedKeys(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map((call) => (call[0] as { queryKey: unknown }).queryKey)
}

beforeEach(() => {
  resetAdminMocks()
  signInAs(ROOT, SUPER_ADMIN_ACCESS)
  serveUsers(() => [ROOT, ADA, CARL])
})

describe('queries', () => {
  test('useUsers is keyed by the search and throws the API error with status and code', async () => {
    listUsers.mockResolvedValue(failed(403, { code: 'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS' }))
    const queryClient = signedInClient()

    const { result } = renderHook(() => useUsers({ q: 'ada' }), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(ApiError)
    expect(result.current.error).toMatchObject({ status: 403, code: 'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS' })
    expect([...usersQueryOptions({ q: 'ada' }).queryKey]).toEqual(['admin', 'users', 'list', { q: 'ada' }])
    // A 4xx is not retried (the app's query defaults).
    expect(listUsers).toHaveBeenCalledTimes(1)
  })

  test('useUser reads one user through the id filter and reports a missing one', async () => {
    const queryClient = signedInClient()

    const found = renderHook(() => useUser(CARL.id, true), { wrapper: wrapper(queryClient) })
    await waitFor(() => expect(found.result.current.data?.email).toBe(CARL.email))
    expect(listUsers).toHaveBeenCalledWith({ query: { filterField: 'id', filterValue: CARL.id, filterOperator: 'eq', limit: 1 } })

    const missing = renderHook(() => useUser('usr_gone', true), { wrapper: wrapper(queryClient) })
    await waitFor(() => expect(missing.result.current.error).toMatchObject({ status: 404, code: 'USER_NOT_FOUND' }))
  })

  test('a network failure is retried once, unlike an HTTP 4xx', async () => {
    listUsers.mockRejectedValue(new TypeError('fetch failed'))
    const queryClient = signedInClient()

    const { result } = renderHook(() => useUsers({}), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(AdminNetworkError)
    expect(result.current.error).not.toBeInstanceOf(ApiError)
    expect(listUsers).toHaveBeenCalledTimes(2)
  })

  test('cached sessions hold no token', async () => {
    listUserSessions.mockResolvedValue(ok({ sessions: [sessionRow('ses_1', CARL.id)] }))
    const queryClient = signedInClient()

    const { result } = renderHook(() => useUserSessions(CARL.id, true), { wrapper: wrapper(queryClient) })

    await waitFor(() => expect(result.current.data?.length).toBe(1))
    expect(JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))).not.toContain('secret-ses_1')
  })

  test('useRoles does not fetch when disabled (no role:read)', async () => {
    const queryClient = signedInClient()
    const { rolesGet } = await import('./api-mock')

    renderHook(() => useRoles(false), { wrapper: wrapper(queryClient) })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(rolesGet).not.toHaveBeenCalled()
  })
})

describe('mutations', () => {
  test('a role change invalidates the users (list and detail) and that user’s sessions', async () => {
    setRole.mockResolvedValue(ok({ user: {} }))
    const queryClient = signedInClient()
    const invalidate = spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useSetRole(), { wrapper: wrapper(queryClient) })

    await result.current.mutateAsync({ userId: CARL.id, expectedRoles: ['user'], role: 'admin' })

    expect(invalidatedKeys(invalidate)).toEqual([
      ['admin', 'users'],
      ['admin', 'sessions', CARL.id],
    ])
  })

  test('a refused change still refreshes the target, and a 401 re-checks the session', async () => {
    setRole.mockResolvedValue(failed(401, { code: 'UNAUTHORIZED' }))
    const queryClient = signedInClient()
    const invalidate = spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useSetRole(), { wrapper: wrapper(queryClient) })

    await expect(result.current.mutateAsync({ userId: CARL.id, expectedRoles: ['user'], role: 'admin' })).rejects.toMatchObject({ status: 401 })

    expect(invalidatedKeys(invalidate)).toEqual([sessionQueryOptions.queryKey, ['admin', 'users'], ['admin', 'sessions', CARL.id]])
  })

  test('a 403 re-reads the signed-in user’s permissions', async () => {
    setRole.mockResolvedValue(failed(403, { code: 'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE' }))
    const queryClient = signedInClient()
    const invalidate = spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useSetRole(), { wrapper: wrapper(queryClient) })

    await expect(result.current.mutateAsync({ userId: CARL.id, expectedRoles: ['user'], role: 'admin' })).rejects.toMatchObject({ status: 403 })

    expect(invalidatedKeys(invalidate)).toContainEqual(permissionsQueryOptions(ROOT.id).queryKey)
  })

  test('a stale target is refused before anything is sent', async () => {
    const queryClient = signedInClient()
    const { result } = renderHook(() => useSetRole(), { wrapper: wrapper(queryClient) })

    // The screen still shows Carl as a user; the API already holds him as an admin.
    serveUsers(() => [{ ...CARL, role: 'admin' }])
    await expect(result.current.mutateAsync({ userId: CARL.id, expectedRoles: ['user'], role: 'super_admin' })).rejects.toMatchObject({
      status: 409,
      code: 'USER_CHANGED',
    })
    expect(setRole).not.toHaveBeenCalled()
  })

  test('revoking a session re-checks the signed-in session, since it may be the one revoked', async () => {
    getSession.mockResolvedValue(ok(sessionOf(ROOT)))
    listUserSessions.mockResolvedValue(ok({ sessions: [sessionRow('ses_1', ROOT.id)] }))
    revokeUserSession.mockResolvedValue(ok({ success: true }))
    const queryClient = signedInClient()
    const invalidate = spyOn(queryClient, 'invalidateQueries')
    const { result } = renderHook(() => useRevokeSession(), { wrapper: wrapper(queryClient) })

    await result.current.mutateAsync({ userId: ROOT.id, sessionId: 'ses_1' })

    expect(revokeUserSession).toHaveBeenCalledWith({ sessionToken: 'secret-ses_1' })
    expect(invalidatedKeys(invalidate)).toContainEqual(sessionQueryOptions.queryKey)
    expect(invalidatedKeys(invalidate)).toContainEqual(['admin', 'sessions', ROOT.id])
  })

  test('the token of a revoked session is kept in neither the query nor the mutation cache, even on failure', async () => {
    const TOKEN = 'sentinel-token-7f3a'
    listUserSessions.mockResolvedValue(ok({ sessions: [{ ...sessionRow('ses_1', CARL.id), token: TOKEN }] }))
    revokeUserSession.mockResolvedValue(failed(503, { code: 'USER_MUTATION_BUSY' }))
    const queryClient = signedInClient()
    const { result } = renderHook(() => useRevokeSession(), { wrapper: wrapper(queryClient) })

    await expect(result.current.mutateAsync({ userId: CARL.id, sessionId: 'ses_1' })).rejects.toMatchObject({ status: 503 })

    expect(revokeUserSession).toHaveBeenCalledWith({ sessionToken: TOKEN })
    const queries = queryClient.getQueryCache().getAll().map((query) => query.state.data)
    const mutations = queryClient.getMutationCache().getAll().map((mutation) => mutation.state)
    expect(JSON.stringify(queries)).not.toContain(TOKEN)
    expect(JSON.stringify(mutations)).not.toContain(TOKEN)
  })
})

test('admin access fixture matches DEC-033: no mutation grants', () => {
  for (const permission of ['user:set-role', 'user:ban', 'session:revoke']) expect(ADMIN_ACCESS.permissions).not.toContain(permission)
})
