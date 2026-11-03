import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { session, user } from '@repo/db'
import { eq } from 'drizzle-orm'
import { auth } from '../../../src/utils/auth'
import { isBanInForce } from '../../../src/utils/auth/bans'
import { cacheStore } from '../../../src/utils/cache'
import { db } from '../../../src/utils/db'
import { memory, request } from '../../helpers/app'
import {
  authPost,
  createUser,
  headers,
  PASSWORD,
  prepareTestDatabase,
  sessionCookie,
  storedUser,
  type TestUser,
} from './setup'

const ready = await prepareTestDatabase()

const HOUR_MS = 60 * 60 * 1000

let spy: ReturnType<typeof spyOn> | undefined

beforeEach(() => memory.clear())
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

function signIn(target: TestUser): Promise<Response> {
  return authPost('/api/auth/sign-in/email', { email: target.email, password: PASSWORD })
}

function ban(admin: TestUser, userId: string): Promise<Response> {
  return authPost('/api/auth/admin/ban-user', { userId }, { cookie: admin.cookie })
}

async function sessionsOf(userId: string): Promise<number> {
  return (await db.select({ id: session.id }).from(session).where(eq(session.userId, userId))).length
}

async function banExpired(userId: string): Promise<void> {
  await db
    .update(user)
    .set({ banned: true, banReason: 'spam', banExpires: new Date(Date.now() - HOUR_MS) })
    .where(eq(user.id, userId))
  await db.delete(session).where(eq(session.userId, userId))
}

interface Gate {
  reached: Promise<void>
  open(): void
}

// Pauses the first call of `method` on `target` until `open()`; later calls run at once.
function gateFirst<T extends object>(target: T, method: keyof T & string, matches: (...args: unknown[]) => boolean = () => true): Gate {
  const original = target[method] as (...args: unknown[]) => Promise<unknown>
  const reached = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let first = true
  // Bun's `spyOn` types the method generically; the call goes to the original with `target` as `this`.
  spy = spyOn(target, method as never).mockImplementation((async (...args: unknown[]) => {
    if (first && matches(...args)) {
      first = false
      reached.resolve()
      await gate.promise
    }
    return original.apply(target, args)
  }) as never)
  return { reached: reached.promise, open: () => gate.resolve() }
}

describe('ban in force', () => {
  const now = new Date()

  test('a ban without an expiry, or expiring later, is in force; an expired one or none is not', () => {
    expect(isBanInForce({ banned: true, banExpires: null }, now)).toBe(true)
    expect(isBanInForce({ banned: true, banExpires: new Date(now.getTime() + HOUR_MS) }, now)).toBe(true)
    expect(isBanInForce({ banned: true, banExpires: new Date(now.getTime() - HOUR_MS) }, now)).toBe(false)
    expect(isBanInForce({ banned: false, banExpires: null }, now)).toBe(false)
    expect(isBanInForce({ banned: null, banExpires: null }, now)).toBe(false)
  })
})

describe.skipIf(!ready)('bans at sign-in (needs the test PostgreSQL)', () => {
  test('an expired ban is lifted at sign-in, audited once without an actor', async () => {
    const target = await createUser()
    await banExpired(target.id)
    memory.clear()

    expect((await signIn(target)).status).toBe(200)

    expect(await storedUser(target.id)).toMatchObject({ banned: false, banReason: null, banExpires: null })
    const lifted = memory.find('audit.user.unbanned')
    expect(lifted).toHaveLength(1)
    expect(lifted[0]).toMatchObject({ userId: target.id })
    expect(lifted[0]).not.toHaveProperty('actorId')
  })

  test('a ban in force refuses sign-in with 403 BANNED_USER', async () => {
    const admin = await createUser('super_admin')
    const target = await createUser()
    expect((await ban(admin, target.id)).status).toBe(200)

    const response = await signIn(target)

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'BANNED_USER' })
  })

  // The admin plugin reads the expired ban, then clears the ban fields unconditionally. Here it is
  // paused between the two while an admin imposes a new, permanent ban. Its clear is cancelled, the
  // conditional lift no longer matches, and the new ban decides.
  test('a ban imposed while sign-in lifts an expired one survives, and sign-in is refused', async () => {
    const admin = await createUser('super_admin')
    const target = await createUser()
    await banExpired(target.id)
    const internal = (await auth.$context).internalAdapter
    const gate = gateFirst(internal, 'updateUser', (_userId, data) => Reflect.get(Object(data), 'banned') === false)

    const signingIn = signIn(target)
    await gate.reached
    expect((await ban(admin, target.id)).status).toBe(200)
    gate.open()
    const response = await signingIn

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'BANNED_USER' })
    expect(await storedUser(target.id)).toMatchObject({ banned: true, banExpires: null })
    expect(await sessionsOf(target.id)).toBe(0)
    expect(memory.find('audit.user.unbanned').filter((event) => event.userId === target.id)).toEqual([])
  })

  // Sign-in has passed every ban check and is about to write the session when the ban lands; the
  // ban's session deletion runs before the session exists. The check after the write catches it.
  test('a ban landing between the ban check and the new session removes that session', async () => {
    const admin = await createUser('super_admin')
    const target = await createUser()
    await db.delete(session).where(eq(session.userId, target.id))
    const adapter = (await auth.$context).adapter
    const gate = gateFirst(adapter, 'create', (args) => Reflect.get(Object(args), 'model') === 'session')

    const signingIn = signIn(target)
    await gate.reached
    expect((await ban(admin, target.id)).status).toBe(200)
    gate.open()
    const response = await signingIn

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'BANNED_USER' })
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith('app.session_token=') && !cookie.startsWith('app.session_token=;'))).toBe(false)
    expect(await sessionsOf(target.id)).toBe(0)
  })
})

function getSession(cookie: string): Promise<Response> {
  return request('/api/auth/get-session', { headers: headers({ cookie }) })
}

// `app.session_token=<token>.<signature>`, URL-encoded.
function tokenOf(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).split('.')[0] ?? ''
}

// What Better Auth 1.7.15 writes under `<token>` when it caches a session.
function sessionEntry(token: string, userId: string): string {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + HOUR_MS)
  return JSON.stringify({
    session: { id: crypto.randomUUID(), token, userId, expiresAt, createdAt: now, updatedAt: now },
    user: { id: userId, email: 'cached@example.test', name: 'Cached', role: 'user', banned: false, createdAt: now, updatedAt: now },
  })
}

async function sessionUserId(cookie: string): Promise<string | undefined> {
  const body = (await (await getSession(cookie)).json()) as { user: { id: string } } | null
  return body?.user.id
}

// Better Auth trusts a Redis session entry without reading PostgreSQL, and keeps the per-user
// session list with non-atomic read-modify-writes. Sessions therefore never go to Redis (DEC-054):
// these are the two schedules that left a revoked cookie working while they did.
describe.skipIf(!ready)('revoked sessions stay revoked (needs the test PostgreSQL)', () => {
  test('a session is kept in PostgreSQL only', async () => {
    const target = await createUser()
    const token = tokenOf(target.cookie)

    expect(await db.select({ id: session.id }).from(session).where(eq(session.token, token))).toHaveLength(1)
    expect(await cacheStore.get(`auth:${token}`)).toBeNull()
    expect(await cacheStore.get(`auth:active-sessions-${target.id}`)).toBeNull()
    expect(await sessionUserId(target.cookie)).toBe(target.id)
  })

  // The first sign-in has read the user's `active-sessions` list and is about to write it back when
  // the second one completes; its write then drops the second token from the list. The ban's sweep
  // follows the list, so with sessions in Redis the second cookie outlived the ban.
  test('a ban ends sessions opened by concurrent sign-ins, and their cookies cannot be replayed', async () => {
    const admin = await createUser('super_admin')
    const target = await createUser()
    const storage = (await auth.$context).secondaryStorage
    if (storage === undefined) throw new Error('Better Auth has no secondary storage')
    const gate = gateFirst(storage, 'set', (key) => typeof key === 'string' && key === `active-sessions-${target.id}`)

    const first = signIn(target)
    await gate.reached
    const second = await signIn(target)
    gate.open()
    const cookies = [target.cookie, sessionCookie(await first), sessionCookie(second)]
    for (const cookie of cookies) expect(await sessionUserId(cookie)).toBe(target.id)

    expect((await ban(admin, target.id)).status).toBe(200)

    for (const cookie of cookies) expect(await sessionUserId(cookie)).toBeUndefined()
    expect(await sessionsOf(target.id)).toBe(0)
  })

  // The session is due for a refresh, and the refresh has read the session when the ban commits.
  // With sessions in Redis, 1.7.15's refresh wrote the entry back and the old cookie worked again.
  test('a refresh racing a ban does not bring the session back', async () => {
    const admin = await createUser('super_admin')
    const target = await createUser()
    await db
      .update(session)
      .set({ expiresAt: new Date(Date.now() + HOUR_MS) })
      .where(eq(session.userId, target.id))
    const adapter = (await auth.$context).adapter
    const gate = gateFirst(adapter, 'update', (args) => Reflect.get(Object(args), 'model') === 'session')

    const refreshing = getSession(target.cookie)
    await gate.reached
    expect((await ban(admin, target.id)).status).toBe(200)
    gate.open()

    expect((await refreshing).status).toBe(401)
    expect(await sessionUserId(target.cookie)).toBeUndefined()
    expect(await cacheStore.get(`auth:${tokenOf(target.cookie)}`)).toBeNull()
  })

  // Whatever reaches Redis for a session (a racing write through Better Auth's storage, or an entry
  // left from before DEC-054) is never trusted: PostgreSQL decides.
  test('a session entry in Redis cannot authenticate a revoked token', async () => {
    const admin = await createUser('super_admin')
    const target = await createUser()
    const token = tokenOf(target.cookie)
    const { secondaryStorage } = await auth.$context
    expect((await ban(admin, target.id)).status).toBe(200)

    await secondaryStorage?.set(token, sessionEntry(token, target.id), 600)
    expect(await cacheStore.get(`auth:${token}`)).toBeNull()
    await cacheStore.set(`auth:${token}`, sessionEntry(token, target.id), 600)

    try {
      expect(await sessionUserId(target.cookie)).toBeUndefined()
    } finally {
      await cacheStore.del([`auth:${token}`])
    }
  })
})
