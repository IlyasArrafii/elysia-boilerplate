import { ALICE, apiFailed, getSession, ok, permissionsGet, rejectWith, resetAuthMocks, signOut, USER_ACCESS } from './api-mock'
import type { PermissionsResult } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// Loaded after `./api-mock` has replaced the API clients.
const { currentHref, renderApp } = await import('./app')

beforeEach(() => {
  resetAuthMocks()
  getSession.mockResolvedValue(ok(ALICE))
})

describe('AccessPage', () => {
  // The route loader awaits the prefetch, so the page mounts with data, or (prefetch failed) retries on mount.
  test('shows a loading state shaped like the list while the permissions load on mount', async () => {
    let release!: (value: PermissionsResult) => void
    permissionsGet
      .mockResolvedValueOnce(apiFailed(429, { code: 'RATE_LIMITED', message: 'x' }))
      .mockReturnValue(new Promise((resolve) => (release = resolve)))

    await renderApp('/access')

    expect(await screen.findByLabelText('Loading your access')).toBeDefined()
    release(ok(USER_ACCESS))
    expect(await screen.findByText('posts:read')).toBeDefined()
    expect(screen.queryByLabelText('Loading your access')).toBeNull()
  })

  test('lists the roles and permissions the API reports', async () => {
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))

    await renderApp('/access')

    const roles = await screen.findByRole('region', { name: 'Roles' })
    expect(within(roles).getByText('user')).toBeDefined()
    const permissions = screen.getByRole('region', { name: 'Permissions' })
    expect(within(permissions).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['posts:read', 'posts:write'])
  })

  test('a role that grants nothing gets an explanation instead of an empty list', async () => {
    permissionsGet.mockResolvedValue(ok({ roles: ['retired_role'], permissions: [] }))

    await renderApp('/access')

    expect(await screen.findByText('Your roles grant no permissions. Pages that only need a session still work.')).toBeDefined()
  })

  test('an API error shows the code and "Try again" recovers', async () => {
    const user = userEvent.setup()
    // 4xx is not retried automatically (src/lib/query-client.ts).
    // Fails for the loader's prefetch and for the page's retry on mount, then recovers.
    permissionsGet.mockResolvedValue(apiFailed(429, { code: 'RATE_LIMITED', message: 'Slow down' }))

    await renderApp('/access')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('RATE_LIMITED')).toBeDefined()
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('posts:write')).toBeDefined()
  })

  test('the header links to the page only when signed in', async () => {
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))

    await renderApp('/access')

    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Your access' }).getAttribute('aria-current')).toBe('page')
  })
})

describe('sign-out (header)', () => {
  test('ends the session, drops the cache and sends the visitor of a protected page to /login', async () => {
    const user = userEvent.setup()
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))
    signOut.mockImplementation(async () => {
      getSession.mockResolvedValue(ok(null))
      return ok({ success: true })
    })
    const { router, queryClient } = await renderApp('/access')
    await screen.findByText('posts:read')

    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    await waitFor(() => expect(currentHref(router)).toBe('/login?redirect=%2Faccess'))
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(['auth', 'permissions', ALICE.user.id])).toBeUndefined()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(within(nav).queryByRole('link', { name: 'Your access' })).toBeNull()
    expect(await screen.findByRole('link', { name: 'Register' })).toBeDefined()
  })

  test('on a public page, the visitor stays and the header turns to sign-in links', async () => {
    const user = userEvent.setup()
    signOut.mockResolvedValue(ok({ success: true }))
    const { router } = await renderApp('/')

    await user.click(await screen.findByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('link', { name: 'Register' })).toBeDefined()
    expect(currentHref(router)).toBe('/')
  })

  test('a failed sign-out keeps the session and says so', async () => {
    const user = userEvent.setup()
    signOut.mockImplementation(rejectWith(500, { code: 'INTERNAL_ERROR' }))
    await renderApp('/')

    await user.click(await screen.findByRole('button', { name: 'Sign out' }))

    expect(await screen.findByText('Sign-out failed. You are still signed in; try again.')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined()
  })
})
