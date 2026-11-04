import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { app } from '../../../src/app'
import { AdminService } from '../../../src/modules/admin/service'
import { assertRouteAccess } from '../../../src/utils/auth'
import { permissionsOf } from '../../../src/utils/auth/access'
import { ROLE_NAMES, roleRegistry } from '../../../src/utils/auth/roles'
import { memory, request } from '../../helpers/app'
import { createUser } from '../../helpers/auth'
import { fixtures, testDb } from '../../helpers/db'

const db = await testDb()
const scope = fixtures(db)

beforeEach(() => memory.clear())
afterAll(() => scope.cleanup())

function getRoles(cookie?: string, path = '/api/admin/roles'): Promise<Response> {
  return request(path, { headers: cookie === undefined ? {} : { cookie } })
}

// API.md §3.5, built from the registry and the compiled roles rather than from the service.
const CATALOGUE = {
  items: ROLE_NAMES.map((role) => ({
    role,
    label: roleRegistry[role].label,
    description: roleRegistry[role].description,
    permissions: permissionsOf(role),
  })),
}

describe('GET /api/admin/roles without a session', () => {
  test('401 UNAUTHORIZED with a request id', async () => {
    const response = await getRoles()

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Sign in to continue' })
    expect(response.headers.get('x-request-id')).toBeString()
  })

  test('the failure is logged once with module admin, and no route field', async () => {
    await getRoles()

    const errors = memory.find('http.error')
    expect(errors).toEqual([expect.objectContaining({ module: 'admin', status: 401, code: 'UNAUTHORIZED' })])
    expect(errors[0]).not.toHaveProperty('route')
    expect(memory.find('http.request')).toEqual([expect.objectContaining({ module: 'admin', route: '/api/admin/roles', status: 401 })])
  })
})

describe('GET /api/admin/roles without role:read', () => {
  test('user: 403 FORBIDDEN with a request id, logged with module admin', async () => {
    const caller = await createUser(scope, db, 'user')
    memory.clear()

    const response = await getRoles(caller.cookie)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: 'FORBIDDEN', message: 'You do not have permission to do this' })
    expect(response.headers.get('x-request-id')).toBeString()
    expect(memory.find('http.error')).toEqual([expect.objectContaining({ module: 'admin', status: 403, code: 'FORBIDDEN' })])
  })

  // NULL is user; unknown roles, including inherited object member names, grant nothing (static-roles.md §2).
  test.each([null, 'ghost', ' admin', 'constructor', '__proto__'])('stored role %p: 403', async (role) => {
    const caller = await createUser(scope, db, role)

    expect((await getRoles(caller.cookie)).status).toBe(403)
  })
})

describe('GET /api/admin/roles with role:read', () => {
  test.each(['admin', 'super_admin', 'admin,ghost'])('%s: 200 with the full catalogue', async (role) => {
    const caller = await createUser(scope, db, role)
    memory.clear()

    const response = await getRoles(caller.cookie)

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBeString()
    expect(await response.json()).toEqual(CATALOGUE)
    expect(memory.find('http.request')).toEqual([expect.objectContaining({ module: 'admin', userId: caller.id, status: 200 })])
  })

  test('the catalogue never lists an impersonation action', async () => {
    const caller = await createUser(scope, db, 'super_admin')

    const body = await (await getRoles(caller.cookie)).text()

    expect(body).not.toContain('impersonate')
  })

  test('an unexpected query string changes nothing', async () => {
    const caller = await createUser(scope, db, 'admin')

    const response = await getRoles(caller.cookie, '/api/admin/roles?page=2&role=user')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(CATALOGUE)
  })

  test('a failure inside the route is 500 INTERNAL_ERROR, logged once with module admin', async () => {
    const caller = await createUser(scope, db, 'admin')
    const spy = spyOn(AdminService, 'roles').mockImplementation(() => {
      throw new Error('catalogue exploded')
    })
    try {
      memory.clear()
      const response = await getRoles(caller.cookie)

      expect(response.status).toBe(500)
      const body = await response.text()
      expect(JSON.parse(body)).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
      expect(body).not.toContain('catalogue exploded')
      const errors = memory.find('http.error')
      expect(errors).toEqual([expect.objectContaining({ module: 'admin', status: 500 })])
      expect(errors[0]).not.toHaveProperty('route')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('mount', () => {
  test('the route is in the app under /api only and passes the default-deny check', async () => {
    const routes = app.routes.map((route) => `${route.method} ${route.path}`)

    expect(routes).toContain('GET /api/admin/roles')
    expect(assertRouteAccess(app)).toBe(app)
    expect((await getRoles(undefined, '/api/api/admin/roles')).status).toBe(404)
  })

  test('Better Auth admin endpoints still answer under /api/auth/admin, not under the module', async () => {
    const caller = await createUser(scope, db, 'admin')

    expect((await getRoles(caller.cookie, '/api/auth/admin/list-users')).status).toBe(200)
    expect((await getRoles(caller.cookie, '/api/admin/auth/admin/list-users')).status).toBe(404)
  })
})
