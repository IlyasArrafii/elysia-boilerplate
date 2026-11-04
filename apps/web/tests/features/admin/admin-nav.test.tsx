import { ADA, ADMIN_ACCESS, apiFailed, CARL, permissionsGet, resetAdminMocks, signInAs, USER_ACCESS } from './api-mock'
import { beforeEach, describe, expect, test } from 'bun:test'
import { QueryClientProvider } from '@tanstack/react-query'
import { screen, waitFor } from '@testing-library/react'

const { AdminNav } = await import('@/features/admin')
const { testQueryClient } = await import('../auth/app')
const { renderWithRouter } = await import('../../helpers/render')

beforeEach(() => resetAdminMocks())

// The header entry the app shell mounts. It reads `usePermissions()`, so it needs a QueryClient and a router.
async function renderNav() {
  const queryClient = testQueryClient()
  await renderWithRouter(() => (
    <QueryClientProvider client={queryClient}>
      <nav aria-label="Main">
        <AdminNav />
      </nav>
    </QueryClientProvider>
  ))
  return queryClient
}

describe('AdminNav', () => {
  test('links to /admin for someone who may open an admin screen', async () => {
    signInAs(ADA, ADMIN_ACCESS)

    await renderNav()

    const link = await screen.findByRole('link', { name: 'Admin' })
    expect(link.getAttribute('href')).toBe('/admin')
  })

  test('renders nothing for a user without admin permissions', async () => {
    signInAs(CARL, USER_ACCESS)

    await renderNav()

    await waitFor(() => expect(permissionsGet).toHaveBeenCalled())
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull()
  })

  test('renders nothing when the permissions cannot be loaded', async () => {
    signInAs(ADA, ADMIN_ACCESS)
    permissionsGet.mockResolvedValue(apiFailed(500, { code: 'INTERNAL_ERROR', message: 'Internal server error' }))

    await renderNav()

    await waitFor(() => expect(permissionsGet).toHaveBeenCalled())
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull()
  })
})
