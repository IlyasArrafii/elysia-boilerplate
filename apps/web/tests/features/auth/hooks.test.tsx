import { ALICE, apiFailed, BOB, failed, getSession, ok, permissionsGet, resetAuthMocks, USER_ACCESS } from './api-mock'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { authKeys } from '@/features/auth/lib/keys'
import { ApiError } from '@/lib/api-error'

// Loaded after `./api-mock` has replaced the API clients.
const { testQueryClient } = await import('../../helpers/app')
const { permissionsQueryOptions, sessionQueryOptions, usePermissions } = await import('@/features/auth')
const { switchIdentity } = await import('@/features/auth/lib/session')
const { watchSession } = await import('@/features/auth/lib/watch')

const ADMIN_ACCESS = { roles: ['admin'], permissions: ['posts:manage_all', 'posts:read', 'posts:write', 'role:read'] }

function noRetryClient(): QueryClient {
  const client = testQueryClient()
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } })
  return client
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function fakeRouter() {
  return { invalidate: mock(async () => undefined) }
}

beforeEach(() => {
  resetAuthMocks()
})

describe('sessionQueryOptions', () => {
  test('uses the key from the factory', () => {
    expect([...sessionQueryOptions.queryKey]).toEqual([...authKeys.session()])
  })

  test('a guest is null', async () => {
    getSession.mockResolvedValue(ok(null))

    await expect(noRetryClient().fetchQuery(sessionQueryOptions)).resolves.toBeNull()
  })

  test('caches the user without the session token', async () => {
    getSession.mockResolvedValue(ok(ALICE))
    const client = noRetryClient()

    const session = await client.fetchQuery(sessionQueryOptions)

    expect(session).toEqual({ user: { id: 'usr_alice', email: 'alice@example.test', name: 'Alice', image: null } })
    expect(JSON.stringify(client.getQueryData(sessionQueryOptions.queryKey))).not.toContain('secret-token-alice')
  })

  test('a failed check throws an AuthError with status and code', async () => {
    getSession.mockResolvedValue(failed(500, { code: 'FAILED_TO_GET_SESSION', message: 'Failed to get session' }))

    await expect(noRetryClient().fetchQuery(sessionQueryOptions)).rejects.toMatchObject({
      name: 'AuthError',
      status: 500,
      code: 'FAILED_TO_GET_SESSION',
    })
  })

  test('a 5xx is retried once, then succeeds', async () => {
    getSession.mockResolvedValueOnce(failed(500, { code: 'FAILED_TO_GET_SESSION' })).mockResolvedValueOnce(ok(ALICE))

    await expect(testQueryClient().fetchQuery(sessionQueryOptions)).resolves.toMatchObject({ user: { id: 'usr_alice' } })
    expect(getSession).toHaveBeenCalledTimes(2)
  })

  test('a network failure becomes NETWORK_ERROR', async () => {
    getSession.mockRejectedValue(new TypeError('fetch failed'))

    await expect(noRetryClient().fetchQuery(sessionQueryOptions)).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 })
  })
})

describe('permissionsQueryOptions', () => {
  test('keys the answer by user', () => {
    expect([...permissionsQueryOptions('usr_alice').queryKey]).toEqual([...authKeys.permissions('usr_alice')])
  })

  test('turns an API error into an ApiError carrying status and code', async () => {
    permissionsGet.mockResolvedValue(apiFailed(401, { code: 'UNAUTHORIZED', message: 'Sign in first' }))

    const error = await noRetryClient()
      .fetchQuery(permissionsQueryOptions('usr_alice'))
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, code: 'UNAUTHORIZED' })
  })
})

describe('usePermissions / can()', () => {
  test('reflects GET /api/me/permissions once loaded', async () => {
    getSession.mockResolvedValue(ok(ALICE))
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))

    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(noRetryClient()) })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.can('posts:write')).toBe(true)
    expect(result.current.can('posts:manage_all')).toBe(false)
    expect(result.current.roles).toEqual(['user'])
  })

  test('fails closed while loading', async () => {
    getSession.mockResolvedValue(ok(ALICE))
    permissionsGet.mockReturnValue(new Promise(() => undefined))

    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(noRetryClient()) })

    await waitFor(() => expect(getSession).toHaveBeenCalled())
    expect(result.current.status).toBe('loading')
    expect(result.current.can('posts:read')).toBe(false)
  })

  test('fails closed for a guest, without asking the API', async () => {
    getSession.mockResolvedValue(ok(null))

    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(noRetryClient()) })

    await waitFor(() => expect(result.current.status).toBe('signed-out'))
    expect(result.current.can('posts:read')).toBe(false)
    expect(permissionsGet).not.toHaveBeenCalled()
  })

  test('fails closed when a refetch fails, even though the older answer is still cached', async () => {
    getSession.mockResolvedValue(ok(ALICE))
    permissionsGet.mockResolvedValueOnce(ok(USER_ACCESS)).mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'x' }))
    const client = noRetryClient()
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.can('posts:read')).toBe(true))

    await act(() => client.refetchQueries({ queryKey: authKeys.permissions('usr_alice') }))

    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(result.current.can('posts:read')).toBe(false)
    expect(result.current.error).toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  test('is unavailable when the session itself cannot be checked, and retry asks for the session again', async () => {
    getSession.mockResolvedValue(failed(500, { code: 'FAILED_TO_GET_SESSION' }))
    const client = noRetryClient()
    client.setQueryDefaults(authKeys.session(), { retry: false })
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.status).toBe('unavailable'))

    getSession.mockResolvedValue(ok(ALICE))
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))
    act(() => result.current.retry())

    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  test('fails closed when only the session refetch fails, though user and permissions are still cached', async () => {
    getSession.mockResolvedValueOnce(ok(ALICE)).mockResolvedValue(failed(500, { code: 'FAILED_TO_GET_SESSION' }))
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))
    const client = noRetryClient()
    client.setQueryDefaults(authKeys.session(), { retry: false })
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.can('posts:read')).toBe(true))

    await act(() => client.refetchQueries({ queryKey: authKeys.session(), exact: true }))

    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    expect(client.getQueryData(authKeys.permissions('usr_alice'))).toEqual(USER_ACCESS)
    expect(result.current.can('posts:read')).toBe(false)
    expect(result.current.permissions).toEqual([])
    expect(result.current.roles).toEqual([])
    expect(result.current.error).toMatchObject({ code: 'FAILED_TO_GET_SESSION' })

    // Retry asks for the session again (not the permissions), and the grants return once it is confirmed.
    getSession.mockResolvedValue(ok(ALICE))
    const sessionCalls = getSession.mock.calls.length
    const permissionCalls = permissionsGet.mock.calls.length
    act(() => result.current.retry())

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(getSession.mock.calls.length).toBe(sessionCalls + 1)
    expect(permissionsGet.mock.calls.length).toBe(permissionCalls)
    expect(result.current.can('posts:read')).toBe(true)
  })

  test('another account never sees the previous account’s permissions', async () => {
    getSession.mockResolvedValue(ok(BOB))
    permissionsGet.mockResolvedValue(ok(ADMIN_ACCESS))
    const client = noRetryClient()
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.can('posts:manage_all')).toBe(true))

    permissionsGet.mockReturnValue(new Promise(() => undefined))
    await act(() => switchIdentity(client, fakeRouter(), { user: { id: 'usr_alice', email: 'alice@example.test', name: 'Alice', image: null } }))

    // TanStack Query notifies subscribers on the next tick.
    await waitFor(() => expect(result.current.status).toBe('loading'))
    expect(result.current.can('posts:manage_all')).toBe(false)
  })

  test('sign-out clears permissions', async () => {
    getSession.mockResolvedValue(ok(ALICE))
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))
    const client = noRetryClient()
    const { result } = renderHook(() => usePermissions(), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.can('posts:read')).toBe(true))

    await act(() => switchIdentity(client, fakeRouter(), null))

    await waitFor(() => expect(result.current.status).toBe('signed-out'))
    expect(result.current.can('posts:read')).toBe(false)
    expect(client.getQueryData(authKeys.permissions('usr_alice'))).toBeUndefined()
  })
})

describe('switchIdentity', () => {
  test('drops everything cached for the previous identity, sets the new session and re-runs the guards', async () => {
    const client = noRetryClient()
    const router = fakeRouter()
    client.setQueryData(['posts', 'list'], ['old'])
    client.setQueryData(authKeys.permissions('usr_bob'), ADMIN_ACCESS)

    await switchIdentity(client, router, null)

    expect(client.getQueryData(['posts', 'list'])).toBeUndefined()
    expect(client.getQueryData(authKeys.permissions('usr_bob'))).toBeUndefined()
    expect(client.getQueryData(authKeys.session())).toBeNull()
    expect(router.invalidate).toHaveBeenCalledTimes(1)
  })
})

describe('watchSession', () => {
  test('a different user seen on refetch (another tab) drops the old cache and re-runs the guards', async () => {
    const client = noRetryClient()
    const router = fakeRouter()
    getSession.mockResolvedValue(ok(ALICE))
    await client.fetchQuery(sessionQueryOptions)
    client.setQueryData(authKeys.permissions('usr_alice'), USER_ACCESS)
    const stop = watchSession(client, router)

    getSession.mockResolvedValue(ok(BOB))
    await client.refetchQueries({ queryKey: authKeys.session() })

    expect(client.getQueryData(authKeys.permissions('usr_alice'))).toBeUndefined()
    expect(router.invalidate).toHaveBeenCalledTimes(1)
    stop()
  })

  test('the same user on refetch changes nothing', async () => {
    const client = noRetryClient()
    const router = fakeRouter()
    getSession.mockResolvedValue(ok(ALICE))
    await client.fetchQuery(sessionQueryOptions)
    client.setQueryData(authKeys.permissions('usr_alice'), USER_ACCESS)
    const stop = watchSession(client, router)

    await client.refetchQueries({ queryKey: authKeys.session() })

    expect(client.getQueryData(authKeys.permissions('usr_alice'))).toEqual(USER_ACCESS)
    expect(router.invalidate).not.toHaveBeenCalled()
    stop()
  })

  test('local changes (switchIdentity) are not handled twice', async () => {
    const client = noRetryClient()
    const router = fakeRouter()
    getSession.mockResolvedValue(ok(ALICE))
    await client.fetchQuery(sessionQueryOptions)
    const stop = watchSession(client, router)

    await switchIdentity(client, router, null)

    expect(router.invalidate).toHaveBeenCalledTimes(1)
    stop()
  })

  test('a 401 from the API makes it re-read the session, and an ended session re-runs the guards', async () => {
    const client = noRetryClient()
    const router = fakeRouter()
    getSession.mockResolvedValue(ok(ALICE))
    // An observer keeps the session query active, as the header does in the app.
    renderHook(() => usePermissions(), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(client.getQueryData(authKeys.session())).not.toBeUndefined())
    const stop = watchSession(client, router)

    getSession.mockResolvedValue(ok(null))
    permissionsGet.mockResolvedValue(apiFailed(401, { code: 'UNAUTHORIZED', message: 'Sign in first' }))
    await client.fetchQuery({ queryKey: ['posts', 'list'], queryFn: () => Promise.reject(new ApiError(401, 'UNAUTHORIZED', 'x')) }).catch(() => undefined)

    await waitFor(() => expect(router.invalidate).toHaveBeenCalledTimes(1))
    expect(client.getQueryData(authKeys.session())).toBeNull()
    stop()
  })
})
