import {
  ADA,
  ADMIN_ACCESS,
  apiFailed,
  CARL,
  getSession,
  ok,
  resetAdminMocks,
  ROOT,
  rolesGet,
  serveUsers,
  signInAs,
  SUPER_ADMIN_ACCESS,
  USER_ACCESS,
  permissionsGet,
} from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { screen, waitFor } from '@testing-library/react'

// Loaded after `./api-mock` has replaced the API clients. The whole app (route tree, guards, shell) is the real one.
const { currentHref, renderApp } = await import('../../helpers/app')

beforeEach(() => {
  resetAdminMocks()
  serveUsers(() => [ROOT, ADA, CARL])
})

describe('every admin route is gated by its permission (static-roles.md §6)', () => {
  test.each(['/admin', '/admin/users', `/admin/users/${CARL.id}`, '/admin/roles'])('a guest visiting %s goes to /login', async (path) => {
    getSession.mockResolvedValue(ok(null))

    const { router } = await renderApp(path)

    expect(currentHref(router)).toBe(`/login?redirect=${encodeURIComponent(path)}`)
  })

  test.each(['/admin', '/admin/users', `/admin/users/${CARL.id}`, '/admin/roles'])(
    'a user visiting %s is sent to / with the forbidden notice',
    async (path) => {
      signInAs(CARL, USER_ACCESS)

      const { router } = await renderApp(path)

      expect(currentHref(router)).toBe('/?notice=forbidden')
      expect(await screen.findByText('Your role does not allow that page, so you were brought here.')).toBeDefined()
    },
  )

  test.each([
    ['admin', ADA, ADMIN_ACCESS],
    ['super_admin', ROOT, SUPER_ADMIN_ACCESS],
  ] as const)('%s opening /admin lands on the user list', async (_name, user, access) => {
    signInAs(user, access)

    const { router } = await renderApp('/admin')

    expect(currentHref(router)).toBe('/admin/users')
    expect(await screen.findByRole('heading', { level: 1, name: 'Users' })).toBeDefined()
    expect(await screen.findByRole('link', { name: CARL.email })).toBeDefined()
  })

  test('a custom role with role:read only lands on the role catalogue and cannot open users', async () => {
    signInAs(CARL, { roles: ['auditor'], permissions: ['role:read'] })

    const first = await renderApp('/admin')
    expect(currentHref(first.router)).toBe('/admin/roles')
    expect(await screen.findByRole('heading', { level: 1, name: 'Roles' })).toBeDefined()
    first.unmount()

    const second = await renderApp('/admin/users')
    expect(currentHref(second.router)).toBe('/?notice=forbidden')
  })

  test('the detail also needs user:get, since it is a separate permission', async () => {
    signInAs(CARL, { roles: ['lister'], permissions: ['user:list'] })

    const { router } = await renderApp(`/admin/users/${CARL.id}`)

    expect(currentHref(router)).toBe('/?notice=forbidden')
  })

  test('when the permissions cannot be loaded, no admin page is shown', async () => {
    signInAs(ROOT, SUPER_ADMIN_ACCESS)
    permissionsGet.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))

    const { router } = await renderApp('/admin/users')

    expect(currentHref(router)).toBe('/admin/users')
    expect(await screen.findByRole('heading', { name: 'This page could not be loaded' })).toBeDefined()
    expect(screen.queryByRole('heading', { level: 1, name: 'Users' })).toBeNull()
    expect(screen.queryByRole('link', { name: CARL.email })).toBeNull()
  })

  test('the role catalogue renders for an admin', async () => {
    signInAs(ADA, ADMIN_ACCESS)

    const { router } = await renderApp('/admin/roles')

    expect(currentHref(router)).toBe('/admin/roles')
    expect(await screen.findByRole('heading', { level: 2, name: 'Permissions by role' })).toBeDefined()
    await waitFor(() => expect(rolesGet).toHaveBeenCalled())
  })
})

describe('admin local navigation', () => {
  test('shows only the screens the compiled permissions open', async () => {
    signInAs(ADA, ADMIN_ACCESS)
    await renderApp('/admin/users')

    const nav = await screen.findByRole('navigation', { name: 'Admin sections' })
    expect(nav.textContent).toContain('User list')
    expect(nav.textContent).toContain('Role catalogue')
  })

  test('a role:read-only role sees the catalogue link but no user list link', async () => {
    signInAs(CARL, { roles: ['auditor'], permissions: ['role:read'] })
    await renderApp('/admin/roles')

    const nav = await screen.findByRole('navigation', { name: 'Admin sections' })
    expect(nav.textContent).toContain('Role catalogue')
    expect(nav.textContent).not.toContain('User list')
  })
})
