import {
  ADA,
  ADMIN_ACCESS,
  apiFailed,
  CARL,
  failed,
  listUsers,
  ok,
  permissionsGet,
  rawUser,
  resetAdminMocks,
  ROOT,
  serveUsers,
  signInAs,
  USER_ACCESS,
} from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { currentHref, renderApp } = await import('../auth/app')
const { permissionsQueryOptions } = await import('@/features/auth')

beforeEach(() => {
  resetAdminMocks()
  signInAs(ADA, ADMIN_ACCESS)
})

describe('/admin/users', () => {
  test('lists users with role and status as text', async () => {
    serveUsers(() => [ROOT, ADA, { ...CARL, banned: true, banReason: 'spam' }])

    await renderApp('/admin/users')

    const table = await screen.findByRole('table', { name: 'Users, newest first' })
    const carl = within(table).getByRole('link', { name: CARL.email }).closest('tr')
    expect(carl).not.toBeNull()
    expect(within(carl as HTMLElement).getByText('Banned')).toBeDefined()
    expect(within(carl as HTMLElement).getByText('user')).toBeDefined()
    expect(within(table).getAllByText('Active')).toHaveLength(2)
    expect(screen.getByText(/Page 1 of 1 · 3 users/)).toBeDefined()
    expect(listUsers).toHaveBeenCalledWith({ query: { limit: 20, offset: 0, sortBy: 'createdAt', sortDirection: 'desc' } })
  })

  test('shows a skeleton while the list has no data yet', async () => {
    serveUsers(() => [CARL])
    const { queryClient } = await renderApp('/admin/users')
    expect(await screen.findByRole('link', { name: CARL.email })).toBeDefined()

    // The loader waits for the first page, so the skeleton shows when the cache has nothing, e.g. after it was reset.
    listUsers.mockImplementation(() => new Promise(() => {}))
    act(() => void queryClient.resetQueries({ queryKey: ['admin', 'users'] }))

    expect(await screen.findByLabelText('Loading users')).toBeDefined()
    expect(screen.queryByRole('link', { name: CARL.email })).toBeNull()
  })

  test('shows the error code and retries', async () => {
    const user = userEvent.setup()
    listUsers.mockResolvedValue(failed(500, { code: 'INTERNAL_ERROR' }))

    await renderApp('/admin/users')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('INTERNAL_ERROR')).toBeDefined()
    expect(within(alert).getByText('The users could not be loaded. Try again.')).toBeDefined()

    serveUsers(() => [CARL])
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: CARL.email })).toBeDefined()
  })

  test('an empty search result offers to clear the search', async () => {
    const user = userEvent.setup()
    serveUsers(() => [])

    const { router } = await renderApp('/admin/users')
    await user.type(await screen.findByLabelText('Search by email'), '  nobody  ')
    await user.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => expect(currentHref(router)).toBe('/admin/users?q=nobody'))
    expect(await screen.findByText(/No user email contains/)).toBeDefined()
    expect(listUsers).toHaveBeenLastCalledWith({
      query: expect.objectContaining({ searchValue: 'nobody', searchField: 'email', searchOperator: 'contains' }),
    })
    await user.click(screen.getByRole('link', { name: 'Clear search' }))
    await waitFor(() => expect(currentHref(router)).toBe('/admin/users'))
  })

  test('pages through the list', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 20 }, (_, index) => rawUser({ id: `usr_${index}`, email: `u${index}@example.test` }))
    listUsers.mockImplementation(async ({ query }) => ok({ users: query.offset === 0 ? many : [CARL], total: 21 }))

    const { router } = await renderApp('/admin/users')
    expect(await screen.findByText(/Page 1 of 2 · 21 users/)).toBeDefined()
    expect(screen.queryByRole('link', { name: 'Previous page' })).toBeNull()

    await user.click(screen.getByRole('link', { name: 'Next page' }))

    await waitFor(() => expect(currentHref(router)).toBe('/admin/users?page=2'))
    expect(await screen.findByRole('link', { name: CARL.email })).toBeDefined()
    expect(screen.getByRole('link', { name: 'Previous page' })).toBeDefined()
  })

  test('opening a user shows the detail next to the list and marks the row', async () => {
    const user = userEvent.setup()
    serveUsers(() => [ROOT, ADA, CARL])

    const { router } = await renderApp('/admin/users')
    await user.click(await screen.findByRole('link', { name: CARL.email }))

    await waitFor(() => expect(currentHref(router)).toBe(`/admin/users/${CARL.id}`))
    expect(await screen.findByRole('heading', { level: 2, name: CARL.name })).toBeDefined()
    expect(screen.getByRole('link', { name: CARL.email }).getAttribute('aria-current')).toBe('page')
  })

  test('after a confirmed loss of user:list the cached list is dropped, and a later permissions failure shows nothing', async () => {
    serveUsers(() => [CARL])
    const { queryClient } = await renderApp('/admin/users')
    expect(await screen.findByRole('link', { name: CARL.email })).toBeDefined()
    const permissionsKey = permissionsQueryOptions(ADA.id).queryKey

    // Demoted meanwhile: the API confirms the new permissions.
    permissionsGet.mockResolvedValue(ok(USER_ACCESS))
    await act(() => queryClient.invalidateQueries({ queryKey: permissionsKey }))
    expect(await screen.findByText('Your role no longer allows the user list.')).toBeDefined()
    await waitFor(() => expect(queryClient.getQueryCache().findAll({ queryKey: ['admin', 'users'] })).toHaveLength(0))

    // Then the permissions cannot be read at all: neither the forbidden note nor the old list comes back.
    permissionsGet.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'x' }))
    await act(() => queryClient.invalidateQueries({ queryKey: permissionsKey }))
    expect(await screen.findByText('Your permissions could not be loaded, so admin actions are hidden.')).toBeDefined()
    expect(screen.queryByText('Your role no longer allows the user list.')).toBeNull()
    expect(screen.queryByRole('link', { name: CARL.email })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
