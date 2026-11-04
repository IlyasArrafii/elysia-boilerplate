import { describe, expect, test } from 'bun:test'
import { createClient, type E2eClient } from '../helpers/client'
import { send, signedInSuperAdmin, signUp } from '../helpers/users'

// `GET /api/me/permissions` per role on the running stack (TESTING.md §3.2). The super_admin is the
// one the seed creates; the admin is a new user it promotes through the admin plugin.

async function permissionsOf(client: E2eClient): Promise<{ roles: string[]; permissions: string[] }> {
  const response = await client.request('/api/me/permissions')
  expect(response.status).toBe(200)
  expect(response.headers.get('x-request-id')).toBeString()
  return response.json() as Promise<{ roles: string[]; permissions: string[] }>
}

describe('GET /api/me/permissions on the running stack', () => {
  test('a guest gets 401 UNAUTHORIZED', async () => {
    const response = await createClient().request('/api/me/permissions')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Sign in to continue' })
  })

  test('a new account is a user who reads and writes posts', async () => {
    const { client } = await signUp('me')

    expect(await permissionsOf(client)).toEqual({ roles: ['user'], permissions: ['posts:read', 'posts:write'] })
  })

  test('the seeded super_admin holds every permission; a user it promotes to admin gets the admin grants', async () => {
    const superAdmin = await signedInSuperAdmin()
    const all = await permissionsOf(superAdmin.client)
    expect(all.roles).toEqual(['super_admin'])
    expect(all.permissions).toEqual(
      expect.arrayContaining(['posts:manage_all', 'posts:read', 'posts:write', 'role:read', 'user:set-role', 'user:ban', 'user:delete']),
    )
    expect(all.permissions.filter((permission) => permission.includes('impersonate'))).toEqual([])

    const promoted = await signUp('me')
    expect((await send(superAdmin.client, 'POST', '/api/auth/admin/set-role', { userId: promoted.id, role: 'admin' })).status).toBe(200)

    // The same session: the role is read from PostgreSQL on the next request (DEC-054).
    expect(await permissionsOf(promoted.client)).toEqual({
      roles: ['admin'],
      permissions: ['posts:manage_all', 'posts:read', 'posts:write', 'role:read', 'session:list', 'user:get', 'user:list'],
    })
  })
})
