import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { session, user } from '@repo/db'
import { Elysia } from 'elysia'
import { eq } from 'drizzle-orm'
import { auth, authGuard } from '../../../src/utils/auth'
import { PERMISSIONS, permissionsOf } from '../../../src/utils/auth/access'
import { memory, request } from '../../helpers/app'
import { authHeaders, createUser } from '../../helpers/auth'
import { fixtures, testDb } from '../../helpers/db'

const db = await testDb()
const scope = fixtures(db)

beforeEach(() => memory.clear())
afterAll(() => scope.cleanup())

function getPermissions(cookie?: string): Promise<Response> {
  return request('/api/me/permissions', { headers: cookie === undefined ? {} : { cookie } })
}

async function permissionsFor(role: string | null): Promise<unknown> {
  const caller = await createUser(scope, db, role)
  const response = await getPermissions(caller.cookie)
  expect(response.status).toBe(200)
  return response.json()
}

describe('GET /api/me/permissions without a session', () => {
  test('401 UNAUTHORIZED with a request id', async () => {
    const response = await getPermissions()

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Sign in to continue' })
    expect(response.headers.get('x-request-id')).toBeString()
  })

  test('the failure is logged once with module me, and no route field', async () => {
    await getPermissions()

    const errors = memory.find('http.error')
    expect(errors).toEqual([expect.objectContaining({ module: 'me', status: 401, code: 'UNAUTHORIZED' })])
    expect(errors[0]).not.toHaveProperty('route')
    expect(memory.find('http.request')).toEqual([expect.objectContaining({ module: 'me', route: '/api/me/permissions', status: 401 })])
  })

  test('a forged or unknown cookie is no session', async () => {
    expect((await getPermissions('app.session_token=forged.signature')).status).toBe(401)
    expect((await getPermissions('app.session_token=')).status).toBe(401)
  })

  test('a signed-out session is refused at once', async () => {
    const caller = await createUser(scope, db)
    const signOut = await request('/api/auth/sign-out', { method: 'POST', headers: authHeaders({ cookie: caller.cookie }) })
    expect(signOut.status).toBe(200)

    expect((await getPermissions(caller.cookie)).status).toBe(401)
  })

  // Redis down or PostgreSQL down must not look like "signed out" (TASK-04).
  test('a failing session lookup is 500 INTERNAL_ERROR, not 401', async () => {
    const caller = await createUser(scope, db)
    const spy = spyOn(auth.api, 'getSession').mockRejectedValue(new Error('session store is down'))
    try {
      const response = await getPermissions(caller.cookie)

      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
      expect(memory.find('http.error')).toEqual([expect.objectContaining({ module: 'me', status: 500 })])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('GET /api/me/permissions with a session', () => {
  test('200 with the API.md shape and the caller id in the log context', async () => {
    const caller = await createUser(scope, db, 'admin')
    memory.clear()

    const response = await getPermissions(caller.cookie)

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBeString()
    expect(await response.json()).toEqual({ roles: ['admin'], permissions: permissionsOf('admin') })
    expect(memory.find('http.request')).toEqual([expect.objectContaining({ module: 'me', userId: caller.id, status: 200 })])
  })

  test('each registry role gets its compiled permissions', async () => {
    expect(await permissionsFor('super_admin')).toEqual({ roles: ['super_admin'], permissions: [...PERMISSIONS] })
    expect(await permissionsFor('user')).toEqual({ roles: ['user'], permissions: [] })
  })

  test('is never stored by a browser or proxy', async () => {
    const response = await getPermissions((await createUser(scope, db)).cookie)

    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  test('NULL is user; an unknown role grants nothing; a known role beside it still counts', async () => {
    expect(await permissionsFor('constructor')).toEqual({ roles: ['constructor'], permissions: [] })
    expect(await permissionsFor('__proto__,admin')).toEqual({ roles: ['__proto__', 'admin'], permissions: permissionsOf('admin') })
    expect(await permissionsFor(null)).toEqual({ roles: ['user'], permissions: [] })
    expect(await permissionsFor('ghost')).toEqual({ roles: ['ghost'], permissions: [] })
    expect(await permissionsFor('admin,ghost')).toEqual({ roles: ['admin', 'ghost'], permissions: permissionsOf('admin') })
    expect(await permissionsFor(' super_admin')).toEqual({ roles: [' super_admin'], permissions: [] })
  })

  // Sessions and roles are read from PostgreSQL on every request (DEC-054); nothing is cached.
  test('a role change applies on the next request, with the same session', async () => {
    const caller = await createUser(scope, db, 'user')
    expect(await (await getPermissions(caller.cookie)).json()).toMatchObject({ roles: ['user'] })

    await db.update(user).set({ role: 'admin' }).where(eq(user.id, caller.id))

    expect(await (await getPermissions(caller.cookie)).json()).toEqual({ roles: ['admin'], permissions: permissionsOf('admin') })
  })
})

// The macro forwards the Set-Cookie Better Auth's `getSession` writes, as `/api/auth/get-session` would.
describe('session cookies through the macro', () => {
  function sessionCookies(response: Response): string[] {
    return response.headers.getSetCookie().filter((cookie) => cookie.startsWith('app.session_token='))
  }

  test('a session past updateAge is extended and its cookie re-sent', async () => {
    const caller = await createUser(scope, db)
    // One hour left of a 7-day session: well past the one-day updateAge.
    await db.update(session).set({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) }).where(eq(session.userId, caller.id))

    const response = await getPermissions(caller.cookie)

    expect(response.status).toBe(200)
    const [refreshed] = sessionCookies(response)
    expect(refreshed).toBeString()
    expect(refreshed).toMatch(/Max-Age=[1-9]\d*/i)
    const [row] = await db.select({ expiresAt: session.expiresAt }).from(session).where(eq(session.userId, caller.id))
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000)
  })

  test('a fresh session sends no cookie', async () => {
    const response = await getPermissions((await createUser(scope, db)).cookie)

    expect(response.headers.getSetCookie()).toEqual([])
  })

  test('an expired session is 401 and its cookie is cleared', async () => {
    const caller = await createUser(scope, db)
    await db.update(session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(session.userId, caller.id))

    const response = await getPermissions(caller.cookie)

    expect(response.status).toBe(401)
    expect(sessionCookies(response)).toEqual([expect.stringMatching(/^app\.session_token=;.*Max-Age=0/i)])
  })

  test('a revoked session is 401 and its cookie is cleared', async () => {
    const caller = await createUser(scope, db)
    await db.delete(session).where(eq(session.userId, caller.id))

    const response = await getPermissions(caller.cookie)

    expect(response.status).toBe(401)
    expect(sessionCookies(response)).toEqual([expect.stringMatching(/^app\.session_token=;.*Max-Age=0/i)])
  })

  test('a cookie set earlier in the request is kept beside the forwarded one', async () => {
    const caller = await createUser(scope, db)
    await db.update(session).set({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) }).where(eq(session.userId, caller.id))
    const withCookie = new Elysia()
      .onRequest(({ set }) => {
        set.headers['set-cookie'] = 'earlier=1; Path=/'
      })
      .use(authGuard)
      .get('/', () => 'ok', { auth: true })

    const response = await withCookie.handle(new Request('http://localhost/', { headers: { cookie: caller.cookie } }))

    const cookies = response.headers.getSetCookie()
    expect(cookies[0]).toBe('earlier=1; Path=/')
    expect(cookies.some((cookie) => cookie.startsWith('app.session_token='))).toBeTrue()
  })
})

describe('Better Auth next to the macros', () => {
  test('its routes still answer under /api/auth only, with no doubled prefix', async () => {
    const caller = await createUser(scope, db)

    const session = await request('/api/auth/get-session', { headers: { cookie: caller.cookie } })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ user: { id: caller.id } })
    expect((await request('/api/api/auth/get-session')).status).toBe(404)
    expect((await request('/api/me/auth/get-session', { headers: { cookie: caller.cookie } })).status).toBe(404)
  })
})
