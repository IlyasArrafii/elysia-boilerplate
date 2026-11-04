import { beforeAll, describe, expect, test } from 'bun:test'
import { createClient, type E2eClient } from '../helpers/client'

// The admin flows on the running stack (TESTING.md §3.2): the role catalogue per role, a role
// change seen on the next request, and admin refused on set-role. The super_admin is the one the
// seed creates; every other user is a new account made here.

const WEB_ORIGIN = process.env.WEB_URL || 'http://localhost:3001'
const run = crypto.randomUUID()
let count = 0

interface CatalogueItem {
  role: string
  label: string
  description: string
  permissions: string[]
}

function seededSuperAdmin(): { email: string; password: string } {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD
  if (!email || !password) {
    throw new Error('SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD must be set to the seeded super_admin (TESTING.md §3.2)')
  }
  return { email, password }
}

function post(client: E2eClient, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return client.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...headers },
    body: JSON.stringify(body),
  })
}

// Sign-up allows 3 a minute per client IP, which the API reads from `x-forwarded-for`. Each account
// here is its own client (198.18.0.0/15, the benchmarking range), so this file neither trips the
// limit nor uses up the budget of other E2E files signing up from the runner's own address.
function clientIp(): string {
  const value = crypto.getRandomValues(new Uint8Array(2))
  return `198.18.${value[0] ?? 0}.${value[1] ?? 0}`
}

async function signedUp(): Promise<{ client: E2eClient; id: string }> {
  count++
  const client = createClient()
  const response = await post(
    client,
    '/api/auth/sign-up/email',
    { email: `e2e+${run}-${count}@example.test`, password: 'correct-horse-battery', name: `E2E User ${count}` },
    { 'x-forwarded-for': clientIp() },
  )
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  return { client, id: user.id }
}

async function catalogue(client: E2eClient): Promise<CatalogueItem[]> {
  const response = await client.request('/api/admin/roles')
  expect(response.status).toBe(200)
  expect(response.headers.get('x-request-id')).toBeString()
  return ((await response.json()) as { items: CatalogueItem[] }).items
}

let superAdmin: E2eClient

beforeAll(async () => {
  superAdmin = createClient()
  expect((await post(superAdmin, '/api/auth/sign-in/email', seededSuperAdmin())).status).toBe(200)
})

describe('GET /api/admin/roles on the running stack', () => {
  test('a guest gets 401 UNAUTHORIZED', async () => {
    const response = await createClient().request('/api/admin/roles')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Sign in to continue' })
  })

  test('a new account (role user) gets 403 FORBIDDEN', async () => {
    const { client } = await signedUp()

    const response = await client.request('/api/admin/roles')

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: 'FORBIDDEN', message: 'You do not have permission to do this' })
  })

  test('super_admin gets every registry role with its compiled permissions, no impersonation', async () => {
    const items = await catalogue(superAdmin)

    expect(items.map((item) => item.role)).toEqual(['super_admin', 'admin', 'user'])
    for (const item of items) {
      expect(item.label).toBeString()
      expect(item.description).toBeString()
      expect(item.permissions).toEqual([...item.permissions].sort())
      expect(item.permissions.filter((permission) => permission.includes('impersonate'))).toEqual([])
    }
    const byRole = Object.fromEntries(items.map((item) => [item.role, item.permissions]))
    expect(byRole.admin).toEqual(['role:read', 'session:list', 'user:get', 'user:list'])
    expect(byRole.user).toEqual([])
    expect(byRole.super_admin).toEqual(expect.arrayContaining([...(byRole.admin ?? []), 'user:set-role', 'user:ban']))

    // The catalogue lists what is enforced: super_admin's row is exactly what it holds.
    const me = (await (await superAdmin.request('/api/me/permissions')).json()) as { permissions: string[] }
    expect(byRole.super_admin).toEqual(me.permissions)
  })
})

describe('role changes (F-03)', () => {
  test('super_admin promotes a user to admin: the next request has the admin grants and the catalogue', async () => {
    const promoted = await signedUp()
    expect((await promoted.client.request('/api/admin/roles')).status).toBe(403)

    expect((await post(superAdmin, '/api/auth/admin/set-role', { userId: promoted.id, role: 'admin' })).status).toBe(200)

    // The same session: the role is read from PostgreSQL on the next request (DEC-054).
    const me = await promoted.client.request('/api/me/permissions')
    expect(await me.json()).toEqual({ roles: ['admin'], permissions: ['role:read', 'session:list', 'user:get', 'user:list'] })
    expect(await catalogue(promoted.client)).toEqual(await catalogue(superAdmin))
  })

  test('admin gets 403 on set-role and the target keeps its role', async () => {
    const admin = await signedUp()
    expect((await post(superAdmin, '/api/auth/admin/set-role', { userId: admin.id, role: 'admin' })).status).toBe(200)
    const target = await signedUp()

    const response = await post(admin.client, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE' })
    expect(await (await target.client.request('/api/me/permissions')).json()).toEqual({ roles: ['user'], permissions: [] })
  })
})
