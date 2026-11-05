import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { auth, userMutationLock } from '../../../src/utils/auth'
import { auditDatabaseHooks } from '../../../src/utils/auth/audit'
import { countUnknownRoles, reportUnknownRoles } from '../../../src/utils/auth/unknown-roles'
import { cacheStore } from '../../../src/utils/cache'
import { db } from '../../../src/utils/db'
import { telemetry } from '../../../src/utils/telemetry'
import { memory, request } from '../../helpers/app'
import { authPost, createUser, headers, PASSWORD, sessionCookie, storedUser, uniqueEmail, uniqueIp, type TestUser } from './setup'

const ready = await prepareOrSkip()

async function prepareOrSkip(): Promise<boolean> {
  const { prepareTestDatabase } = await import('./setup')
  return prepareTestDatabase()
}

let spy: ReturnType<typeof spyOn> | undefined

beforeEach(() => memory.clear())
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

function getSession(cookie?: string): Promise<Response> {
  return request('/api/auth/get-session', { headers: headers(cookie === undefined ? {} : { cookie }) })
}

function asUser(target: TestUser, path: string, body: unknown): Promise<Response> {
  return authPost(path, body, { cookie: target.cookie })
}

describe('mount', () => {
  test('Better Auth answers under /api/auth, and /api/api/auth does not exist', async () => {
    const session = await getSession()

    expect(session.status).toBe(200)
    expect(await session.json()).toBeNull()
    expect((await request('/api/api/auth/get-session', { headers: headers() })).status).toBe(404)
    expect((await request('/auth/get-session', { headers: headers() })).status).toBe(404)
  })

  test('requests are logged with module auth and the route pattern, never the raw path', async () => {
    await request('/api/auth/callback/google?code=SECRETCODE&state=SECRETSTATE', { headers: headers() })

    const [line] = memory.find('http.request')
    expect(line).toMatchObject({ module: 'auth', route: '/api/auth/*' })
    expect(JSON.stringify(memory.lines)).not.toContain('SECRETCODE')
    expect(JSON.stringify(memory.lines)).not.toContain('SECRETSTATE')
  })

  test('a cookie with a bad signature is no session, without a store lookup', async () => {
    spy = spyOn(cacheStore, 'get')

    expect(await (await getSession('app.session_token=forged.signature')).json()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe.skipIf(!ready)('email and password (needs the test PostgreSQL)', () => {
  // Redis down must not look like "signed out": Better Auth answers 500 in its own format, and the
  // request is logged as an auth failure.
  test('a failing session store answers 500 FAILED_TO_GET_SESSION, tagged auth, with nothing leaked', async () => {
    const created = await createUser()
    memory.clear()
    spy = spyOn(cacheStore, 'get').mockRejectedValue(new Error(`lookup failed for ${created.email}`))

    const response = await getSession(created.cookie)

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: 'FAILED_TO_GET_SESSION', message: 'Failed to get session' })
    expect(memory.find('http.request')).toEqual([expect.objectContaining({ module: 'auth', status: 500, level: 'error' })])
    expect(JSON.stringify(memory.lines)).not.toContain(created.email)
  })

  test('sign-up, get-session, sign-out', async () => {
    const email = uniqueEmail()
    const signUp = await authPost('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'New User' })

    expect(signUp.status).toBe(200)
    const setCookie = signUp.headers.getSetCookie().find((cookie) => cookie.startsWith('app.session_token='))
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    const cookie = sessionCookie(signUp)

    const session = await getSession(cookie)
    const body = (await session.json()) as { user: { email: string; role: string } }
    expect(body.user).toMatchObject({ email, role: 'user' })

    const signOut = await authPost('/api/auth/sign-out', {}, { cookie })
    expect(signOut.status).toBe(200)
    expect(await (await getSession(cookie)).json()).toBeNull()
  })

  test('sign-in with the right password opens a session', async () => {
    const created = await createUser()

    const body = (await (await getSession(created.cookie)).json()) as { user: { id: string } }
    expect(body.user.id).toBe(created.id)
  })

  // The real codes recorded in auth/README.md §5 (TASK-04).
  test('an email already registered is 422 USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', async () => {
    const created = await createUser()

    const response = await authPost('/api/auth/sign-up/email', { email: created.email, password: PASSWORD, name: 'Again' })

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' })
  })

  test('a wrong password and an unknown email get the same 401 INVALID_EMAIL_OR_PASSWORD', async () => {
    const created = await createUser()

    const wrong = await authPost('/api/auth/sign-in/email', { email: created.email, password: 'wrong-password' })
    const unknown = await authPost('/api/auth/sign-in/email', { email: uniqueEmail(), password: 'wrong-password' })

    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    const expected = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }
    expect(await wrong.json()).toEqual(expected)
    expect(await unknown.json()).toEqual(expected)
  })

  test('the sixth sign-in attempt from one IP within 60 s is 429', async () => {
    const created = await createUser()
    const ip = uniqueIp()
    const attempt = () => authPost('/api/auth/sign-in/email', { email: created.email, password: 'wrong-password' }, { 'x-forwarded-for': ip })

    const statuses: number[] = []
    for (let index = 0; index < 5; index++) statuses.push((await attempt()).status)
    const sixth = await attempt()

    expect(statuses).toEqual([401, 401, 401, 401, 401])
    expect(sixth.status).toBe(429)
    expect(sixth.headers.get('x-retry-after')).toBe('60')
    expect(await sixth.json()).toEqual({ message: 'Too many requests. Please try again later.' })
    // Another IP is not affected.
    expect((await authPost('/api/auth/sign-in/email', { email: created.email, password: PASSWORD })).status).toBe(200)
  })

  test('a banned user cannot sign in: 403 BANNED_USER', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    expect((await asUser(superAdmin, '/api/auth/admin/ban-user', { userId: target.id })).status).toBe(200)

    const response = await authPost('/api/auth/sign-in/email', { email: target.email, password: PASSWORD })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'BANNED_USER' })
    // Banning revoked the sessions it had.
    expect(await (await getSession(target.cookie)).json()).toBeNull()
  })
})

describe.skipIf(!ready)('guard rules (static-roles.md §7)', () => {
  test.each(['/api/auth/admin/impersonate-user', '/api/auth/admin/stop-impersonating'])(
    '%s is 404 even for super_admin, and audited',
    async (path) => {
      const superAdmin = await createUser('super_admin')
      const target = await createUser()
      memory.clear()

      const response = await asUser(superAdmin, path, { userId: target.id })

      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ code: 'NOT_FOUND' })
      expect(memory.find('audit.auth.blocked_endpoint')).toEqual([
        expect.objectContaining({ module: 'auth', path: path.replace('/api/auth', ''), actorId: superAdmin.id }),
      ])
    },
  )

  test.each([
    ['GET', '/api/auth/admin/get-user?id=someone'],
    ['POST', '/api/auth/admin/create-user'],
    ['POST', '/api/auth/admin/update-user'],
    ['POST', '/api/auth/admin/set-user-password'],
    ['POST', '/api/auth/admin/has-permission'],
  ])('%s %s is not in API.md §3.1, so it is 404 for super_admin', async (method, path) => {
    const superAdmin = await createUser('super_admin')

    const response = await request(path, {
      method,
      headers: { ...headers({ cookie: superAdmin.cookie }), 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ userId: superAdmin.id, permissions: { user: ['list'] } }) } : {}),
    })

    expect(response.status).toBe(404)
  })

  test('a guest is 404 on impersonation too, and audited without an actor', async () => {
    const response = await authPost('/api/auth/admin/impersonate-user', { userId: 'anyone' })

    expect(response.status).toBe(404)
    const [event] = memory.find('audit.auth.blocked_endpoint')
    expect(event).toMatchObject({ path: '/admin/impersonate-user' })
    expect(event).not.toHaveProperty('actorId')
  })

  test('listed admin endpoints still work, with Better Auth permission checks', async () => {
    const superAdmin = await createUser('super_admin')
    const admin = await createUser('admin')
    const user = await createUser()

    const list = (target: TestUser) => request('/api/auth/admin/list-users?limit=1', { headers: headers({ cookie: target.cookie }) })

    expect((await list(superAdmin)).status).toBe(200)
    expect((await list(admin)).status).toBe(200)
    expect((await list(user)).status).toBe(403)
    expect((await request('/api/auth/admin/list-users', { headers: headers() })).status).toBe(401)
  })

  test('nobody changes their own role: 400 CANNOT_CHANGE_OWN_ROLE', async () => {
    const superAdmin = await createUser('super_admin')

    const response = await asUser(superAdmin, '/api/auth/admin/set-role', { userId: superAdmin.id, role: 'user' })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'CANNOT_CHANGE_OWN_ROLE' })
    expect((await storedUser(superAdmin.id))?.role).toBe('super_admin')
  })

  test.each([['ghost'], [['admin', 'ghost']], ['admin,super_admin'], [[]]])('role %p is not in the registry: 400 INVALID_ROLE', async (role) => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()

    const response = await asUser(superAdmin, '/api/auth/admin/set-role', { userId: target.id, role })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'INVALID_ROLE' })
    expect((await storedUser(target.id))?.role).toBe('user')
  })

  test('super_admin sets a registry role; admin may not', async () => {
    const superAdmin = await createUser('super_admin')
    const admin = await createUser('admin')
    const target = await createUser()

    const denied = await asUser(admin, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'YOU_ARE_NOT_ALLOWED_TO_CHANGE_USERS_ROLE' })

    expect((await asUser(superAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })).status).toBe(200)
    expect((await storedUser(target.id))?.role).toBe('admin')
  })

  test.each(['/api/auth/admin/ban-user', '/api/auth/admin/remove-user'])('%s on yourself is 400 CANNOT_TARGET_SELF', async (path) => {
    const superAdmin = await createUser('super_admin')

    const response = await asUser(superAdmin, path, { userId: superAdmin.id })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'CANNOT_TARGET_SELF' })
    expect(await storedUser(superAdmin.id)).toMatchObject({ banned: false })
  })

  test('a guest calling set-role is 401: the guards judge signed-in callers only', async () => {
    const response = await authPost('/api/auth/admin/set-role', { userId: 'someone', role: 'ghost' })

    expect(response.status).toBe(401)
  })

  // Better Auth parses `userId` with `z.coerce.string()` after this hook runs, so `["<own id>"]`
  // would reach set-role as the caller's own ID. Only a string is accepted (hooks.ts).
  const notAString = (id: string): unknown[] => [[id], [[id]], { id }, null, 12345, '']

  test('a userId that is not a string is 400 INVALID_USER_ID, so the sole super_admin keeps the role', async () => {
    const superAdmin = await createUser('super_admin')

    for (const userId of notAString(superAdmin.id)) {
      const response = await asUser(superAdmin, '/api/auth/admin/set-role', { userId, role: 'user' })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_USER_ID' })
    }
    expect(await storedUser(superAdmin.id)).toMatchObject({ role: 'super_admin', banned: false })
  })

  test.each([
    '/api/auth/admin/ban-user',
    '/api/auth/admin/unban-user',
    '/api/auth/admin/remove-user',
    '/api/auth/admin/list-user-sessions',
    '/api/auth/admin/revoke-user-sessions',
  ])('%s refuses a userId that is not a string', async (path) => {
    const superAdmin = await createUser('super_admin')

    for (const userId of notAString(superAdmin.id)) {
      const response = await asUser(superAdmin, path, { userId })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'INVALID_USER_ID' })
    }
    expect(await storedUser(superAdmin.id)).toMatchObject({ role: 'super_admin', banned: false })
    expect(await (await getSession(superAdmin.cookie)).json()).not.toBeNull()
  })

  test('the same refusal applies to server-side calls', async () => {
    const superAdmin = await createUser('super_admin')
    const call = () =>
      auth.api.setRole({
        // A body the types forbid, as an unvalidated caller could still send it.
        body: { userId: [superAdmin.id] as unknown as string, role: 'user' },
        headers: new Headers({ cookie: superAdmin.cookie }),
      })

    await expect(userMutationLock.run(call)).rejects.toMatchObject({ body: { code: 'INVALID_USER_ID' } })
    expect((await storedUser(superAdmin.id))?.role).toBe('super_admin')
  })

  test('server-side permission checks are not blocked (the permission macro uses them, TASK-05)', async () => {
    const admin = await createUser('admin')

    const result = await auth.api.userHasPermission({ body: { userId: admin.id, permissions: { user: ['list'] } } })

    expect(result).toMatchObject({ success: true })
  })

  test('other unlisted admin endpoints are blocked for server-side calls too', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    const asSuperAdmin = () => new Headers({ cookie: superAdmin.cookie })

    await expect(
      auth.api.setUserPassword({ body: { userId: target.id, newPassword: 'another-password-1' }, headers: asSuperAdmin() }),
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(
      auth.api.createUser({ body: { email: uniqueEmail(), password: PASSWORD, name: 'Created' }, headers: asSuperAdmin() }),
    ).rejects.toMatchObject({ statusCode: 404 })
    await expect(auth.api.getUser({ query: { id: target.id }, headers: asSuperAdmin() })).rejects.toMatchObject({ statusCode: 404 })
  })

  test('server-side impersonation is blocked too', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()

    const call = auth.api.impersonateUser({ body: { userId: target.id }, headers: new Headers({ cookie: superAdmin.cookie }) })

    await expect(call).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe.skipIf(!ready)('stored roles (needs the test PostgreSQL)', () => {
  const hasPermission = (userId: string, permissions: Record<string, string[]>) =>
    auth.api.userHasPermission({ body: { userId, permissions } })

  test('role NULL is treated as user: signs in, no admin access, no error', async () => {
    const nullRole = await createUser(null)
    const user = await createUser()

    expect((await storedUser(nullRole.id))?.role).toBeNull()
    expect((await getSession(nullRole.cookie)).status).toBe(200)
    expect(await hasPermission(nullRole.id, { user: ['list'] })).toEqual(await hasPermission(user.id, { user: ['list'] }))
    expect(await hasPermission(nullRole.id, { user: ['list'] })).toMatchObject({ success: false })
    expect((await request('/api/auth/admin/list-users', { headers: headers({ cookie: nullRole.cookie }) })).status).toBe(403)
  })

  test('an unknown role grants nothing and is reported at startup; NULL is not reported', async () => {
    const ghost = await createUser('ghost')
    await createUser(null)

    expect(await hasPermission(ghost.id, { user: ['list'] })).toMatchObject({ success: false })
    expect((await request('/api/auth/admin/list-users', { headers: headers({ cookie: ghost.cookie }) })).status).toBe(403)

    const counts = await countUnknownRoles(db)
    expect(counts.find((entry) => entry.role === 'ghost')?.count).toBeGreaterThanOrEqual(1)
    expect(counts.map((entry) => entry.role)).not.toContain('user')

    await reportUnknownRoles(db, telemetry)
    const [event] = memory.find('rbac.unknown_role')
    expect(event).toMatchObject({ level: 'warn', module: 'core' })
    expect(event?.roles).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'ghost' })]))
  })
})

describe.skipIf(!ready)('mixed known and unknown roles (needs the test PostgreSQL)', () => {
  const hasPermission = (userId: string, permissions: Record<string, string[]>) =>
    auth.api.userHasPermission({ body: { userId, permissions } })

  // Better Auth grants a permission when any held role does; an unknown role adds nothing and takes
  // nothing away (roles.ts). The same rule holds in the admin endpoints and in userHasPermission.
  test('known roles keep their grants beside an unknown one, and the unknown one is still reported', async () => {
    const mixedSuperAdmin = await createUser('super_admin,retired_role')
    const mixedAdmin = await createUser('admin,retired_role')
    const target = await createUser()

    expect(await hasPermission(mixedSuperAdmin.id, { user: ['set-role'] })).toMatchObject({ success: true })
    expect(await hasPermission(mixedAdmin.id, { user: ['list'] })).toMatchObject({ success: true })
    expect(await hasPermission(mixedAdmin.id, { user: ['set-role'] })).toMatchObject({ success: false })
    expect((await asUser(mixedSuperAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })).status).toBe(200)
    expect((await asUser(mixedAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'user' })).status).toBe(403)

    const counts = await countUnknownRoles(db)
    expect(counts.find((entry) => entry.role === 'retired_role')?.count).toBeGreaterThanOrEqual(2)
    expect(counts.map((entry) => entry.role)).not.toContain('super_admin')
  })
})

describe.skipIf(!ready)('session tokens in list-user-sessions (needs the test PostgreSQL)', () => {
  interface ListedSession {
    id: string
    token?: string
  }

  async function listSessions(caller: TestUser, userId: string): Promise<ListedSession[]> {
    const response = await asUser(caller, '/api/auth/admin/list-user-sessions', { userId })
    expect(response.status).toBe(200)
    return ((await response.json()) as { sessions: ListedSession[] }).sessions
  }

  // Defence in depth: a raw token turns into a credential once `bearer()` is added or the secret leaks, so an
  // admin (`session:list` only) never receives one, not even a super_admin's.
  test("the admin role gets the sessions without their tokens, a super_admin's included", async () => {
    const admin = await createUser('admin')
    const superAdmin = await createUser('super_admin')

    const sessions = await listSessions(admin, superAdmin.id)

    expect(sessions.length).toBeGreaterThanOrEqual(1)
    expect(sessions.every((session) => typeof session.id === 'string' && !('token' in session))).toBe(true)
    const rawToken = decodeURIComponent(superAdmin.cookie.split('=')[1] ?? '').split('.')[0] ?? ''
    expect(rawToken).not.toBe('')
    expect(JSON.stringify(sessions)).not.toContain(rawToken)
  })

  // `revoke-user-session` takes the token, and it checks `session:revoke`, which super_admin holds.
  test('a caller allowed to revoke still gets the tokens, and can revoke one session with it', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()

    const sessions = await listSessions(superAdmin, target.id)
    const token = sessions[0]?.token

    expect(typeof token).toBe('string')
    const revoked = await asUser(superAdmin, '/api/auth/admin/revoke-user-session', { sessionToken: token })
    expect(revoked.status).toBe(200)
  })
})

describe.skipIf(!ready)('unexpected errors (needs the test PostgreSQL)', () => {
  // better-call prints a non-APIError with `console.error` unless Better Auth rethrows it
  // (`onAPIError.throw`); the API's error handler then logs it through the scrubber.
  test('a failing write answers 500 and nothing reaches the console', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    const internal = (await auth.$context).internalAdapter
    spy = spyOn(internal, 'updateUser').mockRejectedValue(new Error(`write failed for ${target.email}`))
    const printed: string[] = []
    const record = (...args: unknown[]): true => {
      printed.push(args.map(String).join(' '))
      return true
    }
    const consoleSpies = [
      spyOn(console, 'error').mockImplementation(record),
      spyOn(console, 'warn').mockImplementation(record),
      spyOn(console, 'log').mockImplementation(record),
      spyOn(process.stderr, 'write').mockImplementation(record),
      spyOn(process.stdout, 'write').mockImplementation(record),
    ]
    memory.clear()

    let response: Response
    try {
      response = await asUser(superAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })
    } finally {
      for (const consoleSpy of consoleSpies) consoleSpy.mockRestore()
    }

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
    expect(printed).toEqual([])
    expect(memory.find('http.error')).toEqual([expect.objectContaining({ module: 'auth', status: 500, err: expect.anything() })])
    expect(JSON.stringify(memory.lines)).not.toContain(target.email)

    // The lock was released with the failed request.
    spy.mockRestore()
    spy = undefined
    expect((await asUser(superAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })).status).toBe(200)
  })
})

describe.skipIf(!ready)('audit events (auth/README.md §6)', () => {
  function only(event: string) {
    return memory.find(event)
  }

  test('sign-in creates a session and sign-out revokes it, with the user as actor', async () => {
    const created = await createUser()
    memory.clear()
    const ip = uniqueIp()

    const signIn = await authPost(
      '/api/auth/sign-in/email',
      { email: created.email, password: PASSWORD },
      { 'x-forwarded-for': ip, 'user-agent': 'test-agent/1.0' },
    )
    const cookie = sessionCookie(signIn)
    const [createdEvent] = only('audit.session.created')
    expect(createdEvent).toMatchObject({ module: 'auth', kind: 'audit', userId: created.id, ip, userAgent: 'test-agent/1.0' })
    // The sign-in request itself is logged with the user it signed in.
    expect(only('http.request')).toEqual([expect.objectContaining({ userId: created.id, module: 'auth' })])

    memory.clear()
    await authPost('/api/auth/sign-out', {}, { cookie })
    expect(only('audit.session.revoked')).toEqual([
      expect.objectContaining({ module: 'auth', userId: created.id, sessionId: createdEvent?.sessionId, actorId: created.id }),
    ])
  })

  test('a failed sign-in is audited with IP and reason, never the email', async () => {
    const email = uniqueEmail()
    const ip = uniqueIp()

    await authPost('/api/auth/sign-in/email', { email, password: 'wrong-password' }, { 'x-forwarded-for': ip })

    expect(only('audit.auth.sign_in_failed')).toEqual([
      expect.objectContaining({ module: 'auth', ip, reason: 'INVALID_EMAIL_OR_PASSWORD' }),
    ])
    expect(JSON.stringify(memory.lines)).not.toContain(email)
    expect(JSON.stringify(memory.lines)).not.toContain('wrong-password')
  })

  test('a role change records from, to, the target and the actor', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    memory.clear()

    await asUser(superAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })

    expect(only('audit.user.role_changed')).toEqual([
      expect.objectContaining({ module: 'auth', userId: target.id, from: 'user', to: 'admin', actorId: superAdmin.id }),
    ])
  })

  // audit.ts pairs `user.update.before` with `after` through a WeakMap keyed by the endpoint
  // context. That relies on Better Auth 1.7.15 handing both hooks the same object: an upgrade that
  // stops doing so must fail here, not silently drop role and ban events.
  test('Better Auth passes the same context object to user.update before and after', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    const update = auditDatabaseHooks.user?.update
    if (update?.before === undefined || update.after === undefined) throw new Error('audit user.update hooks are missing')
    const contexts: { before: unknown[]; after: unknown[] } = { before: [], after: [] }
    const beforeSpy = spyOn(update, 'before').mockImplementation(async (_data, ctx) => {
      contexts.before.push(ctx)
    })
    const afterSpy = spyOn(update, 'after').mockImplementation(async (_user, ctx) => {
      contexts.after.push(ctx)
    })

    try {
      expect((await asUser(superAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })).status).toBe(200)
    } finally {
      beforeSpy.mockRestore()
      afterSpy.mockRestore()
    }

    expect(contexts.before).toHaveLength(1)
    expect(contexts.before[0]).toBeObject()
    expect(contexts.after).toEqual(contexts.before)
    expect(contexts.after[0]).toBe(contexts.before[0])
  })

  test('setting the role a user already has records nothing', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    memory.clear()

    await asUser(superAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'user' })

    expect(only('audit.user.role_changed')).toEqual([])
  })

  test('ban and unban record the actor and expiry, never the reason; banning revokes sessions', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    memory.clear()

    await asUser(superAdmin, '/api/auth/admin/ban-user', { userId: target.id, banReason: 'private-reason-text', banExpiresIn: 3600 })

    const [banned] = only('audit.user.banned')
    expect(banned).toMatchObject({ module: 'auth', userId: target.id, actorId: superAdmin.id, expiresAt: expect.any(String) })
    // The sign-up and the sign-in session of the target, both revoked by the admin.
    const revoked = only('audit.session.revoked')
    expect(revoked).toHaveLength(2)
    expect(revoked.every((event) => event.actorId === superAdmin.id && event.userId === target.id)).toBe(true)
    expect(JSON.stringify(memory.lines)).not.toContain('private-reason-text')

    memory.clear()
    await asUser(superAdmin, '/api/auth/admin/unban-user', { userId: target.id })
    expect(only('audit.user.unbanned')).toEqual([
      expect.objectContaining({ module: 'auth', userId: target.id, actorId: superAdmin.id }),
    ])
  })

  test('an admin revoking sessions is the actor of each revocation', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    memory.clear()

    const response = await asUser(superAdmin, '/api/auth/admin/revoke-user-sessions', { userId: target.id })

    expect(response.status).toBe(200)
    const revoked = only('audit.session.revoked')
    expect(revoked.length).toBeGreaterThanOrEqual(1)
    expect(revoked.every((event) => event.actorId === superAdmin.id && event.userId === target.id)).toBe(true)
  })

  // Sign-out catches a failed delete and still answers 200 (Better Auth 1.7.15), so an event sent
  // before the delete would report a session that is still alive.
  test('a session delete that fails is not audited as revoked', async () => {
    const created = await createUser()
    const adapter = (await auth.$context).adapter
    spy = spyOn(adapter, 'delete').mockRejectedValue(new Error('delete failed'))
    memory.clear()

    const response = await authPost('/api/auth/sign-out', {}, { cookie: created.cookie })

    expect(response.status).toBe(200)
    expect(spy).toHaveBeenCalled()
    expect(only('audit.session.revoked')).toEqual([])
    spy.mockRestore()
    spy = undefined
    // The session was not deleted, so it still works.
    expect(await (await getSession(created.cookie)).json()).not.toBeNull()
  })

  test('no audit or request line carries an email', async () => {
    const created = await createUser()

    expect(JSON.stringify(memory.lines)).not.toContain(created.email)
  })
})
