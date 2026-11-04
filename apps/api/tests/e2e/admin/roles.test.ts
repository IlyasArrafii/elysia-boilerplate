import { beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type E2eClient } from '../helpers/client'
import { send, signedInSuperAdmin, signUp, type Account } from '../helpers/users'

// The admin flows on the running stack (TESTING.md §3.2): the role catalogue per role, a role
// change seen on the next request, and admin refused on set-role. The super_admin is the one the
// seed creates; every other user is a new account made here.

// The compiled grants of every module (admin and posts, static-roles.md §5).
const ADMIN_PERMISSIONS = ['posts:manage_all', 'posts:read', 'posts:write', 'role:read', 'session:list', 'user:get', 'user:list']
const USER_PERMISSIONS = ['posts:read', 'posts:write']

interface CatalogueItem {
  role: string
  label: string
  description: string
  permissions: string[]
}

async function catalogue(client: E2eClient): Promise<CatalogueItem[]> {
  const response = await client.request('/api/admin/roles')
  expect(response.status).toBe(200)
  expect(response.headers.get('x-request-id')).toBeString()
  return ((await response.json()) as { items: CatalogueItem[] }).items
}

let superAdmin: Account

beforeAll(async () => {
  superAdmin = await signedInSuperAdmin()
})

describe('GET /api/admin/roles on the running stack', () => {
  test('a guest gets 401 UNAUTHORIZED', async () => {
    const response = await createClient().request('/api/admin/roles')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Sign in to continue' })
  })

  test('a new account (role user) gets 403 FORBIDDEN', async () => {
    const { client } = await signUp('admin')

    const response = await client.request('/api/admin/roles')

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: 'FORBIDDEN', message: 'You do not have permission to do this' })
  })

  test('super_admin gets every registry role with its compiled permissions, no impersonation', async () => {
    const items = await catalogue(superAdmin.client)

    expect(items.map((item) => item.role)).toEqual(['super_admin', 'admin', 'user'])
    for (const item of items) {
      expect(item.label).toBeString()
      expect(item.description).toBeString()
      expect(item.permissions).toEqual([...item.permissions].sort())
      expect(item.permissions.filter((permission) => permission.includes('impersonate'))).toEqual([])
    }
    const byRole = Object.fromEntries(items.map((item) => [item.role, item.permissions]))
    expect(byRole.admin).toEqual(ADMIN_PERMISSIONS)
    expect(byRole.user).toEqual(USER_PERMISSIONS)
    expect(byRole.super_admin).toEqual(expect.arrayContaining([...ADMIN_PERMISSIONS, 'user:set-role', 'user:ban']))

    // The catalogue lists what is enforced: super_admin's row is exactly what it holds.
    const me = (await (await superAdmin.client.request('/api/me/permissions')).json()) as { permissions: string[] }
    expect(byRole.super_admin).toEqual(me.permissions)
  })
})

describe('role changes (F-03)', () => {
  test('super_admin promotes a user to admin: the next request has the admin grants and the catalogue', async () => {
    const promoted = await signUp('admin')
    expect((await promoted.client.request('/api/admin/roles')).status).toBe(403)

    expect((await send(superAdmin.client, 'POST', '/api/auth/admin/set-role', { userId: promoted.id, role: 'admin' })).status).toBe(200)

    // The same session: the role is read from PostgreSQL on the next request (DEC-054).
    const me = await promoted.client.request('/api/me/permissions')
    expect(await me.json()).toEqual({ roles: ['admin'], permissions: ADMIN_PERMISSIONS })
    expect(await catalogue(promoted.client)).toEqual(await catalogue(superAdmin.client))
  })

  test('admin gets 403 on set-role and the target keeps its role', async () => {
    const admin = await signUp('admin')
    expect((await send(superAdmin.client, 'POST', '/api/auth/admin/set-role', { userId: admin.id, role: 'admin' })).status).toBe(200)
    const target = await signUp('admin')

    const response = await send(admin.client, 'POST', '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE' })
    expect(await (await target.client.request('/api/me/permissions')).json()).toEqual({ roles: ['user'], permissions: USER_PERMISSIONS })
  })
})
