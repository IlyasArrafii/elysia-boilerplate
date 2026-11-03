import { describe, expect, test } from 'bun:test'
import { createClient, type E2eClient } from '../helpers/client'

// `GET /api/me/permissions` per role on the running stack (TESTING.md §3.2). The super_admin is the
// one the seed creates; the admin is a new user it promotes through the admin plugin.

const WEB_ORIGIN = process.env.WEB_URL || 'http://localhost:3001'
const run = crypto.randomUUID()
let count = 0

function seededSuperAdmin(): { email: string; password: string } {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD
  if (!email || !password) {
    throw new Error('SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD must be set to the seeded super_admin (TESTING.md §3.2)')
  }
  return { email, password }
}

function post(client: E2eClient, path: string, body: unknown): Promise<Response> {
  return client.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify(body),
  })
}

async function signedUp(): Promise<{ client: E2eClient; id: string }> {
  count++
  const client = createClient()
  const response = await post(client, '/api/auth/sign-up/email', {
    email: `e2e+${run}-${count}@example.test`,
    password: 'correct-horse-battery',
    name: `E2E User ${count}`,
  })
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  return { client, id: user.id }
}

async function permissionsOf(client: E2eClient): Promise<{ roles: string[]; permissions: string[] }> {
  const response = await client.request('/api/me/permissions')
  expect(response.status).toBe(200)
  return response.json() as Promise<{ roles: string[]; permissions: string[] }>
}

describe('GET /api/me/permissions on the running stack', () => {
  test('a guest gets 401 UNAUTHORIZED', async () => {
    const response = await createClient().request('/api/me/permissions')

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  test('a new account is a user with no permissions', async () => {
    const { client } = await signedUp()

    expect(await permissionsOf(client)).toEqual({ roles: ['user'], permissions: [] })
  })

  test('the seeded super_admin holds every permission; a user it promotes to admin gets the admin grants', async () => {
    const superAdmin = createClient()
    const signIn = await post(superAdmin, '/api/auth/sign-in/email', seededSuperAdmin())
    expect(signIn.status).toBe(200)
    const all = await permissionsOf(superAdmin)
    expect(all.roles).toContain('super_admin')
    expect(all.permissions).toContain('user:set-role')

    const promoted = await signedUp()
    expect((await post(superAdmin, '/api/auth/admin/set-role', { userId: promoted.id, role: 'admin' })).status).toBe(200)

    // The same session: the role is read from PostgreSQL on the next request (DEC-054).
    expect(await permissionsOf(promoted.client)).toEqual({
      roles: ['admin'],
      permissions: ['role:read', 'session:list', 'user:get', 'user:list'],
    })
  })
})
