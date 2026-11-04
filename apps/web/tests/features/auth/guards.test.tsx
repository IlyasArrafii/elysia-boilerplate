import { ALICE, failed, getSession, ok, permissionsGet, resetAuthMocks, signInSocial, USER_ACCESS } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { isRedirect } from '@tanstack/react-router'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthSession } from '@/features/auth'

// Loaded after `./api-mock` has replaced the API clients.
const { currentHref, renderApp, testQueryClient } = await import('../../helpers/app')
const { requirePermission, sessionQueryOptions } = await import('@/features/auth')

beforeEach(() => {
  resetAuthMocks()
  permissionsGet.mockResolvedValue(ok(USER_ACCESS))
})

describe('protected pages (requireSession)', () => {
  test('a guest is sent to /login, which remembers where they were going', async () => {
    getSession.mockResolvedValue(ok(null))

    const { router } = await renderApp('/access')

    expect(currentHref(router)).toBe('/login?redirect=%2Faccess')
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Your access' })).toBeNull()
  })

  test('a signed-in user sees the page', async () => {
    getSession.mockResolvedValue(ok(ALICE))

    const { router } = await renderApp('/access')

    expect(currentHref(router)).toBe('/access')
    expect(await screen.findByRole('heading', { level: 1, name: 'Your access' })).toBeDefined()
    expect(await screen.findByText('posts:write')).toBeDefined()
  })

  test('client navigation re-checks a stale cached session and redirects once it has ended', async () => {
    const queryClient = testQueryClient()
    // Signed in when cached a minute ago (older than the 30s staleTime); signed out since.
    const cached: AuthSession = { user: { id: ALICE.user.id, email: ALICE.user.email, name: 'Alice', image: null } }
    queryClient.setQueryData(sessionQueryOptions.queryKey, cached, { updatedAt: Date.now() - 60_000 })
    getSession.mockResolvedValue(ok(null))
    const { router } = await renderApp('/', queryClient)

    await router.navigate({ to: '/access' })

    await waitFor(() => expect(currentHref(router)).toBe('/login?redirect=%2Faccess'))
    expect(getSession).toHaveBeenCalled()
  })

  test('when the session cannot be checked, the page is not shown; "Try again" re-runs the guard', async () => {
    const user = userEvent.setup()
    // Failing on the first call and on the one automatic retry a 5xx gets.
    getSession.mockResolvedValue(failed(500, { code: 'FAILED_TO_GET_SESSION' }))

    const { router } = await renderApp('/access')

    expect(await screen.findByRole('heading', { name: 'This page could not be loaded' })).toBeDefined()
    expect(screen.getByText('FAILED_TO_GET_SESSION')).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Your access' })).toBeNull()

    getSession.mockResolvedValue(ok(ALICE))
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Your access' })).toBeDefined()
    expect(currentHref(router)).toBe('/access')
  })
})

describe('guest pages (redirectSignedIn)', () => {
  test.each([
    ['/login', '/'],
    ['/register', '/'],
    ['/login?redirect=%2Faccess', '/access'],
  ])('a signed-in user visiting %s goes to %s', async (path, expected) => {
    getSession.mockResolvedValue(ok(ALICE))

    const { router } = await renderApp(path)

    await waitFor(() => expect(currentHref(router)).toBe(expected))
  })

  test.each([
    ['an absolute URL', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash path', '/\\evil.example'],
    ['a dot segment that normalises to //host', '/a/..//evil.example'],
    ['an encoded dot segment that normalises to //host', '/a/%2e%2e//evil.example'],
  ])('a redirect to %s is never followed', async (_, target) => {
    getSession.mockResolvedValue(ok(ALICE))

    const { router } = await renderApp(`/login?redirect=${encodeURIComponent(target)}`)

    await waitFor(() => expect(currentHref(router)).toBe('/'))
  })

  test('a guest on /login with an unsafe redirect gets links and a Google callback that stay on /', async () => {
    const user = userEvent.setup()
    getSession.mockResolvedValue(ok(null))
    signInSocial.mockResolvedValue(ok({ url: 'https://accounts.google.com/o/oauth2/auth', redirect: true }))

    await renderApp(`/login?redirect=${encodeURIComponent('//evil.example')}`)

    expect((await screen.findByRole('link', { name: 'Create one' })).getAttribute('href')).toBe('/register')
    await user.click(screen.getByRole('button', { name: 'Continue with Google' }))
    expect(signInSocial).toHaveBeenCalledWith(expect.objectContaining({ callbackURL: '/', errorCallbackURL: '/login' }))
  })

  test('if the session cannot be checked, the sign-in form is still shown', async () => {
    getSession.mockResolvedValue(failed(500, { code: 'FAILED_TO_GET_SESSION' }))

    const { router } = await renderApp('/login')

    expect(currentHref(router)).toBe('/login')
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeDefined()
  })
})

describe('requirePermission', () => {
  const session = { user: { id: ALICE.user.id, email: ALICE.user.email, name: 'Alice', image: null } }

  test('lets a user with the permission through', async () => {
    await expect(requirePermission(testQueryClient(), session, 'posts:read')).resolves.toBeUndefined()
  })

  test('sends a user without the permission to / with the forbidden notice', async () => {
    const error = await requirePermission(testQueryClient(), session, 'user:set-role').catch((e: unknown) => e)

    expect(isRedirect(error)).toBe(true)
    expect((error as { options: { href?: string } }).options.href).toBe('/?notice=forbidden')
  })

  test('fails closed when the permissions cannot be loaded', async () => {
    permissionsGet.mockResolvedValue({ data: null, error: { status: 500, value: { code: 'INTERNAL_ERROR', message: 'x' } } })
    const queryClient = testQueryClient()
    queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } })

    await expect(requirePermission(queryClient, session, 'posts:read')).rejects.toMatchObject({ status: 500 })
  })

  test('the app shell explains the redirect on /', async () => {
    getSession.mockResolvedValue(ok(ALICE))

    await renderApp('/?notice=forbidden')

    expect(await screen.findByText('Your role does not allow that page, so you were brought here.')).toBeDefined()
  })
})
