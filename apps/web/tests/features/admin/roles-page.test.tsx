import { ADA, ADMIN_ACCESS, apiFailed, CATALOGUE, ok, resetAdminMocks, rolesGet, serveUsers, signInAs } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const { renderApp } = await import('../../helpers/app')

beforeEach(() => {
  resetAdminMocks()
  serveUsers(() => [ADA])
  signInAs(ADA, ADMIN_ACCESS)
})

describe('/admin/roles', () => {
  test('lists every role and a permission × role table with grants as text', async () => {
    await renderApp('/admin/roles')

    const list = await screen.findByRole('region', { name: 'Role list' })
    for (const role of CATALOGUE.items) {
      expect(within(list).getByText(role.label)).toBeDefined()
      expect(within(list).getByText(role.description)).toBeDefined()
    }

    const table = screen.getByRole('table', { name: 'Which role holds each permission' })
    const banRow = within(table).getByRole('rowheader', { name: 'user:ban' }).closest('tr') as HTMLElement
    // super_admin, admin, user: only super_admin may ban (DEC-033).
    expect(within(banRow).getAllByText(/Granted|Not granted/).map((cell) => cell.textContent)).toEqual(['Granted', 'Not granted', 'Not granted'])
    expect(screen.queryByRole('button', { name: /edit|delete|create/i })).toBeNull()
  })

  test('shows the error code and retries', async () => {
    const user = userEvent.setup()
    rolesGet.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))

    await renderApp('/admin/roles')

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('INTERNAL_ERROR')).toBeDefined()
    rolesGet.mockResolvedValue(ok(CATALOGUE))
    await user.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('table', { name: 'Which role holds each permission' })).toBeDefined()
  })

  test('an empty catalogue says so', async () => {
    rolesGet.mockResolvedValue(ok({ items: [] }))

    await renderApp('/admin/roles')

    expect(await screen.findByText('The API lists no roles.')).toBeDefined()
  })

  test('shows a skeleton while the catalogue has no data yet', async () => {
    const { queryClient } = await renderApp('/admin/roles')
    await screen.findByRole('table', { name: 'Which role holds each permission' })

    rolesGet.mockImplementation(() => new Promise(() => {}))
    act(() => void queryClient.resetQueries({ queryKey: ['admin', 'roles'] }))

    expect(await screen.findByLabelText('Loading roles')).toBeDefined()
  })

  test('a 403 on the catalogue refreshes the permissions and shows the forbidden state', async () => {
    const { queryClient } = await renderApp('/admin/roles')
    await screen.findByRole('table', { name: 'Which role holds each permission' })

    // The role was changed meanwhile: the API now refuses, and the next permissions answer agrees.
    signInAs(ADA, { roles: ['user'], permissions: ['posts:read'] })
    rolesGet.mockResolvedValue(apiFailed(403, { code: 'FORBIDDEN', message: 'You do not have permission to do this' }))
    await act(() => queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] }))

    expect(await screen.findByText('Your role no longer allows the role catalogue.')).toBeDefined()
    expect(screen.queryByRole('table', { name: 'Which role holds each permission' })).toBeNull()
  })
})
