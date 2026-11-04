import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { app } from '../../../src/app'
import { assertRouteAccess, authGuard, type Permission } from '../../../src/utils/auth'
import { PERMISSIONS, permissionsOf } from '../../../src/utils/auth/access'
import { ROLE_NAMES, type RoleName } from '../../../src/utils/auth/roles'
import { errorHandler } from '../../../src/utils/error'
import { moduleScope, mountModule } from '../../../src/utils/logger/module'
import { loggerPlugin } from '../../../src/utils/logger/plugin'
import { memory, request, requestFrom } from '../../helpers/app'
import { createUser, type SignedInUser } from '../../helpers/auth'
import { fixtures, testDb } from '../../helpers/db'

// static-roles.md §5, for the permissions that exist today (posts rows added in TASK-08).
// Written by hand on purpose: a grant change must be made here too, as a reviewed decision.
const EXPECTED: Record<RoleName, readonly Permission[]> = {
  super_admin: [
    'posts:manage_all',
    'posts:read',
    'posts:write',
    'role:read',
    'session:delete',
    'session:list',
    'session:revoke',
    'user:ban',
    'user:create',
    'user:delete',
    'user:get',
    'user:list',
    'user:set-password',
    'user:set-role',
    'user:update',
  ],
  admin: ['posts:manage_all', 'posts:read', 'posts:write', 'role:read', 'session:list', 'user:get', 'user:list'],
  user: ['posts:read', 'posts:write'],
}

// One `permission` route per permission, mounted the way app.ts mounts a module.
function probeApp() {
  const probe = new Elysia({ name: 'probe', prefix: '/probe' }).use(moduleScope('probe')).use(authGuard)
  // An index, not the permission, in the path: `:` would start a path parameter.
  PERMISSIONS.forEach((permission, index) => {
    probe.get(`/${index}`, ({ user, session }) => ({ userId: user.id, sessionUserId: session.userId }), { permission })
  })
  return new Elysia({ prefix: '/api' }).use(loggerPlugin).use(errorHandler).use(mountModule(probe))
}

const callProbe = requestFrom(probeApp())

function statusFor(permission: Permission, cookie?: string): Promise<number> {
  const path = `/api/probe/${PERMISSIONS.indexOf(permission)}`
  return callProbe(path, { headers: cookie === undefined ? {} : { cookie } }).then((response) => response.status)
}

// Every permission → the status the macro answers for this caller.
async function statuses(cookie?: string): Promise<Record<string, number>> {
  const entries = await Promise.all(PERMISSIONS.map(async (permission) => [permission, await statusFor(permission, cookie)]))
  return Object.fromEntries(entries)
}

function expectedStatuses(granted: readonly Permission[]): Record<string, number> {
  return Object.fromEntries(PERMISSIONS.map((permission) => [permission, granted.includes(permission) ? 200 : 403]))
}

const db = await testDb()
const scope = fixtures(db)
const callers = new Map<string | null, SignedInUser>()

async function callerWith(role: string | null): Promise<SignedInUser> {
  const existing = callers.get(role)
  if (existing !== undefined) return existing
  const created = await createUser(scope, db, role)
  callers.set(role, created)
  return created
}

beforeEach(() => memory.clear())
afterAll(() => scope.cleanup())

describe('permission matrix (static-roles.md §5, §11)', () => {
  test('the expected table names every permission that exists', () => {
    expect([...EXPECTED.super_admin].sort()).toEqual([...PERMISSIONS])
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLE_NAMES].sort())
  })

  test.each([...ROLE_NAMES])('%s: every permission matches the grant table', async (role) => {
    const caller = await callerWith(role)

    expect(await statuses(caller.cookie)).toEqual(expectedStatuses(EXPECTED[role]))
  })

  test('guest: every permission route is 401, before any permission check', async () => {
    expect(await statuses()).toEqual(Object.fromEntries(PERMISSIONS.map((permission) => [permission, 401])))
  })

  test('NULL is user, unknown roles grant nothing, a known role beside one keeps its grants', async () => {
    expect(await statuses((await callerWith(null)).cookie)).toEqual(expectedStatuses(EXPECTED.user))
    expect(await statuses((await callerWith('ghost')).cookie)).toEqual(expectedStatuses([]))
    expect(await statuses((await callerWith('admin,ghost')).cookie)).toEqual(expectedStatuses(EXPECTED.admin))
    expect(await statuses((await callerWith('super_admin,ghost')).cookie)).toEqual(expectedStatuses(EXPECTED.super_admin))
    expect(await statuses((await callerWith(' super_admin')).cookie)).toEqual(expectedStatuses([]))
  })

  // Names an ordinary object inherits: Better Auth looks roles up as `roles[name]`, so these must find
  // nothing (access.ts) and answer 403, never 500, alone or next to a known role.
  test.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('stored role "%s" is just an unknown role', async (name) => {
    expect(await statuses((await callerWith(name)).cookie)).toEqual(expectedStatuses([]))
    expect(await statuses((await callerWith(`${name},admin`)).cookie)).toEqual(expectedStatuses(EXPECTED.admin))
    expect(await statuses((await callerWith(`admin,${name}`)).cookie)).toEqual(expectedStatuses(EXPECTED.admin))
  })

  test('GET /api/me/permissions lists exactly what the macro lets through', async () => {
    for (const role of [...ROLE_NAMES, null, 'ghost', 'constructor,admin', '__proto__']) {
      const caller = await callerWith(role)
      const body = (await (await request('/api/me/permissions', { headers: { cookie: caller.cookie } })).json()) as {
        permissions: Permission[]
      }
      const allowed = Object.entries(await statuses(caller.cookie))
        .filter(([, status]) => status === 200)
        .map(([permission]) => permission)

      expect(body.permissions).toEqual(allowed as Permission[])
    }
  })
})

describe('compiled-roles snapshot (static-roles.md §11)', () => {
  // role → sorted permission list; a grant change shows up as a diff of the committed snapshot.
  test('matches the committed snapshot and the grant table', () => {
    const compiled: Record<string, readonly Permission[]> = Object.fromEntries(ROLE_NAMES.map((role) => [role, permissionsOf(role)]))

    expect(compiled).toMatchSnapshot()
    expect(compiled).toEqual(EXPECTED)
  })
})

describe('permission macro responses', () => {
  test('403 FORBIDDEN, logged once with the module that owns the route', async () => {
    const caller = await callerWith('user')
    memory.clear()

    const response = await callProbe(`/api/probe/${PERMISSIONS.indexOf('user:list')}`, { headers: { cookie: caller.cookie } })

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ code: 'FORBIDDEN', message: 'You do not have permission to do this' })
    expect(memory.find('http.error')).toEqual([expect.objectContaining({ module: 'probe', status: 403, code: 'FORBIDDEN' })])
  })

  test('the handler gets the caller user and session', async () => {
    const caller = await callerWith('admin')

    const response = await callProbe(`/api/probe/${PERMISSIONS.indexOf('user:list')}`, { headers: { cookie: caller.cookie } })

    expect(await response.json()).toEqual({ userId: caller.id, sessionUserId: caller.id })
  })
})

describe('typing', () => {
  test('only Permission values compile; a cast past the type still fails at declaration', () => {
    const guarded = () => new Elysia().use(authGuard)

    // @ts-expect-error a typo is not a Permission
    expect(() => guarded().get('/', () => 'ok', { permission: 'user:lsit' })).toThrow('Unknown permission "user:lsit"')
    // @ts-expect-error an undeclared resource
    expect(() => guarded().get('/', () => 'ok', { permission: 'comments:read' })).toThrow('Unknown permission')
    // @ts-expect-error impersonation is never in the statement (DEC-032)
    expect(() => guarded().get('/', () => 'ok', { permission: 'user:impersonate' })).toThrow('Unknown permission')
    expect(() => guarded().get('/', () => 'ok', { permission: 'user:list' })).not.toThrow()
  })

  test('user and session are typed only where an option resolves them', () => {
    const guarded = new Elysia().use(authGuard)

    guarded.get(
      '/auth',
      ({ user, session }) => {
        const id: string = user.id
        const role: string | null | undefined = user.role
        const expiresAt: Date = session.expiresAt
        return { id, role, expiresAt }
      },
      { auth: true },
    )
    guarded.get('/permission', ({ user, session }) => ({ id: user.id, token: session.token }), { permission: 'role:read' })
    // @ts-expect-error a route without an option has no user
    guarded.get('/public', ({ user }) => user)

    expect(guarded.routes.map((route) => route.path)).toEqual(['/auth', '/permission', '/public'])
  })
})

describe('default deny (DEC-010)', () => {
  test('the real app declares access on every route that is not documented Public', () => {
    expect(assertRouteAccess(app)).toBe(app)
    expect(app.routes.map((route) => `${route.method} ${route.path}`)).toContain('GET /api/me/permissions')
  })

  test('a route with neither option fails startup, naming the route', () => {
    const open = new Elysia({ prefix: '/api' }).use(authGuard).get('/forgotten', () => 'open')

    expect(() => assertRouteAccess(open)).toThrow('GET /api/forgotten: declare `auth: true` or `permission`')
  })

  test('auth: false is not a declaration', () => {
    const disabled = new Elysia({ prefix: '/api' }).use(authGuard).get('/off', () => 'open', { auth: false })

    expect(() => assertRouteAccess(disabled)).toThrow('GET /api/off')
  })

  test('protected routes and listed public routes pass', () => {
    const mixed = new Elysia({ prefix: '/api' })
      .use(authGuard)
      .get('/mine', ({ user }) => user.id, { auth: true })
      .get('/admin', ({ user }) => user.id, { permission: 'user:list' })
      .get('/open', () => 'open')

    expect(() => assertRouteAccess(mixed, [{ method: 'GET', path: '/api/open' }])).not.toThrow()
    expect(() => assertRouteAccess(mixed, [])).toThrow('GET /api/open')
  })

  test('a Public entry matches its method only', () => {
    const posted = new Elysia({ prefix: '/api' }).post('/health/', () => 'open')

    expect(() => assertRouteAccess(posted)).toThrow('POST /api/health/')
  })
})
