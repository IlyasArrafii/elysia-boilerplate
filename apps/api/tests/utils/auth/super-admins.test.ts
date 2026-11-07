import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { user } from '@repo/db'
import { sql } from 'drizzle-orm'
import { auth, userMutationLock } from '../../../src/utils/auth'
import { createUserMutationLock, UserMutationBusyError } from '../../../src/utils/auth/user-mutation-lock'
import { isUsableSuperAdmin, wouldRemoveLastSuperAdmin } from '../../../src/utils/auth/super-admins'
import { db } from '../../../src/utils/db'
import { memory } from '../../helpers/app'
import { lockHolderPid, lockWaiters, waitFor, withOnlySuperAdmins } from '../../helpers/user-mutation'
import { authPost, createUser, prepareTestDatabase, storedUser, type TestUser } from './setup'

const ready = await prepareTestDatabase()

const HOUR_MS = 60 * 60 * 1000

let spy: ReturnType<typeof spyOn> | undefined

beforeEach(() => memory.clear())
afterEach(() => {
  spy?.mockRestore()
  spy = undefined
})

function asUser(actor: TestUser, path: string, body: unknown): Promise<Response> {
  return authPost(path, body, { cookie: actor.cookie })
}

interface Gate {
  // Resolves when the first gated write has been reached: the request is past every guard and the
  // endpoint's own permission check, holding the lock, about to write.
  reached: Promise<void>
  open(): void
}

// Pauses the first role/ban write (Better Auth's `internalAdapter.updateUser`) until `open()`. Later
// calls run at once.
async function gateFirstUpdate(): Promise<Gate> {
  const internal = (await auth.$context).internalAdapter
  const original = internal.updateUser
  const reached = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  let first = true
  spy = spyOn(internal, 'updateUser').mockImplementation(async (...args: Parameters<typeof original>) => {
    if (first) {
      first = false
      reached.resolve()
      await gate.promise
    }
    return original(...args)
  })
  return { reached: reached.promise, open: () => gate.resolve() }
}

// Another API instance: its own in-process queue, the same database lock. It calls Better Auth
// server-side, as a module would.
const otherInstance = createUserMutationLock()

const SECOND_OPERATIONS = {
  '/api/auth/admin/set-role': (userId: string, headers: Headers) =>
    auth.api.setRole({ body: { userId, role: 'user' }, headers, asResponse: true }),
  '/api/auth/admin/ban-user': (userId: string, headers: Headers) => auth.api.banUser({ body: { userId }, headers, asResponse: true }),
  '/api/auth/admin/remove-user': (userId: string, headers: Headers) =>
    auth.api.removeUser({ body: { userId }, headers, asResponse: true }),
} as const

const BODIES = {
  '/api/auth/admin/set-role': { role: 'user' },
  '/api/auth/admin/ban-user': {},
  '/api/auth/admin/remove-user': {},
} as const

type SecondPath = keyof typeof SECOND_OPERATIONS
const SECOND_PATHS = Object.keys(SECOND_OPERATIONS) as SecondPath[]

function fromOtherInstance(actor: TestUser, path: SecondPath, userId: string): Promise<Response> {
  return otherInstance.run(() => SECOND_OPERATIONS[path](userId, new Headers({ cookie: actor.cookie })))
}

// Which of `ids` are still usable super_admins, in the database.
async function superAdminIds(ids: string[]): Promise<string[]> {
  const rows = await Promise.all(ids.map(async (id) => ({ id, row: await storedUser(id) })))
  return rows.filter(({ row }) => row !== undefined && row.role === 'super_admin' && row.banned !== true).map(({ id }) => id)
}

describe('usable super_admin', () => {
  const now = new Date()
  const row = (role: string | null, banned: boolean | null = false, banExpires: Date | null = null) => ({ role, banned, banExpires })

  test('holds super_admin, alone or beside other roles, known or not', () => {
    expect(isUsableSuperAdmin(row('super_admin'), now)).toBe(true)
    expect(isUsableSuperAdmin(row('admin,super_admin'), now)).toBe(true)
    expect(isUsableSuperAdmin(row('super_admin,retired'), now)).toBe(true)
  })

  test('a name that only contains super_admin, NULL, or another role is not one', () => {
    expect(isUsableSuperAdmin(row('super_admins'), now)).toBe(false)
    expect(isUsableSuperAdmin(row('not_super_admin'), now)).toBe(false)
    expect(isUsableSuperAdmin(row(null), now)).toBe(false)
    expect(isUsableSuperAdmin(row('admin'), now)).toBe(false)
    // Better Auth does not trim role names, so a padded one grants nothing and is not counted.
    expect(isUsableSuperAdmin(row(' super_admin'), now)).toBe(false)
    expect(isUsableSuperAdmin(row('admin, super_admin'), now)).toBe(false)
  })

  test('a running or open-ended ban makes one unusable; an expired ban does not', () => {
    expect(isUsableSuperAdmin(row('super_admin', true), now)).toBe(false)
    expect(isUsableSuperAdmin(row('super_admin', true, new Date(now.getTime() + HOUR_MS)), now)).toBe(false)
    expect(isUsableSuperAdmin(row('super_admin', true, new Date(now.getTime() - HOUR_MS)), now)).toBe(true)
    expect(isUsableSuperAdmin(row('super_admin', null), now)).toBe(true)
  })
})

describe.skipIf(!ready)('last super_admin (needs the test PostgreSQL)', () => {
  test('is detected from the database, counting only other usable super_admins', async () => {
    const sole = await createUser('super_admin')
    const plain = await createUser()

    await withOnlySuperAdmins(db, [sole.id], async () => {
      expect(await wouldRemoveLastSuperAdmin(db, sole.id)).toBe(true)
      expect(await wouldRemoveLastSuperAdmin(db, plain.id)).toBe(false)
      expect(await wouldRemoveLastSuperAdmin(db, 'no-such-user')).toBe(false)

      const banned = await createUser('super_admin')
      await db.update(user).set({ banned: true }).where(sql`${user.id} = ${banned.id}`)
      expect(await wouldRemoveLastSuperAdmin(db, sole.id)).toBe(true)

      await db.update(user).set({ banExpires: new Date(Date.now() - HOUR_MS) }).where(sql`${user.id} = ${banned.id}`)
      expect(await wouldRemoveLastSuperAdmin(db, sole.id)).toBe(false)
    })
  })

  // Sessions are read from PostgreSQL with the user's current row (DEC-054), so a session opened
  // before the demotion carries the new role at once and cannot act as super_admin.
  test('a super_admin demoted in SQL cannot use an older session to remove the last one', async () => {
    const stale = await createUser('super_admin')
    const last = await createUser('super_admin')

    await withOnlySuperAdmins(db, [last.id], async () => {
      for (const [path, body] of [
        ['/api/auth/admin/set-role', { userId: last.id, role: 'admin' }],
        ['/api/auth/admin/ban-user', { userId: last.id }],
        ['/api/auth/admin/remove-user', { userId: last.id }],
      ] as const) {
        expect((await asUser(stale, path, body)).status).toBe(403)
      }
      expect(await storedUser(last.id)).toMatchObject({ role: 'super_admin', banned: false })
    })
  })

  test('demoting one of two super_admins, or promoting while demoting, is allowed', async () => {
    const actor = await createUser('super_admin')
    const other = await createUser('super_admin')

    await withOnlySuperAdmins(db, [actor.id, other.id], async () => {
      expect((await asUser(actor, '/api/auth/admin/set-role', { userId: other.id, role: ['admin', 'super_admin'] })).status).toBe(200)
      expect((await asUser(actor, '/api/auth/admin/set-role', { userId: other.id, role: 'admin' })).status).toBe(200)
      expect((await storedUser(other.id))?.role).toBe('admin')
    })
  })

  // Two super_admins act on each other at the same time. The first is paused after every guard and
  // Better Auth's permission check, holding the lock, just before it writes; the second is then seen
  // waiting, in this process's queue or (from another instance) for the PostgreSQL lock, so it cannot
  // have run its own checks yet. Without the lock the second would reach the write too and `waitFor`
  // would time out. Once the first commits, the second runs against the new state: its actor is no
  // longer a super_admin (sessions are read with the user's current row, DEC-054), so it is refused.
  // LAST_SUPER_ADMIN, checked under the lock, also covers an actor demoted in SQL after its session
  // was read.
  test.each(SECOND_PATHS)('a demotion and a concurrent %s in the same instance cannot both succeed', async (secondPath) => {
    const first = await createUser('super_admin')
    const second = await createUser('super_admin')

    await withOnlySuperAdmins(db, [first.id, second.id], async () => {
      const gate = await gateFirstUpdate()

      const demotion = asUser(first, '/api/auth/admin/set-role', { userId: second.id, role: 'user' })
      await gate.reached
      const counter = asUser(second, secondPath, { userId: first.id, ...BODIES[secondPath] })
      await waitFor(async () => userMutationLock.waiting() === 1, 'the second request waits for its turn')
      gate.open()
      const [demoted, countered] = await Promise.all([demotion, counter])

      expect(demoted.status).toBe(200)
      expect(countered.status).toBe(403)
      expect(await superAdminIds([first.id, second.id])).toEqual([first.id])
    })
  })

  test.each(SECOND_PATHS)('a demotion and a concurrent %s from another instance cannot both succeed', async (secondPath) => {
    const first = await createUser('super_admin')
    const second = await createUser('super_admin')

    await withOnlySuperAdmins(db, [first.id, second.id], async () => {
      const gate = await gateFirstUpdate()

      const demotion = asUser(first, '/api/auth/admin/set-role', { userId: second.id, role: 'user' })
      await gate.reached
      const counter = fromOtherInstance(second, secondPath, first.id)
      await waitFor(async () => (await lockWaiters(db)) === 1, 'the other instance waits for the database lock')
      gate.open()
      const [demoted, countered] = await Promise.all([demotion, counter])

      expect(demoted.status).toBe(200)
      expect(countered.status).toBe(403)
      expect(await superAdminIds([first.id, second.id])).toEqual([first.id])
    })
  })

  // The lock and the writes share one transaction. When the lock's connection dies, the lock is free
  // for another instance, and the paused request's write cannot land afterwards on another
  // connection: it goes to the dead transaction and fails.
  test.each(SECOND_PATHS)('losing the lock connection voids the paused demotion; %s from another instance then wins', async (secondPath) => {
    const first = await createUser('super_admin')
    const second = await createUser('super_admin')

    await withOnlySuperAdmins(db, [first.id, second.id], async () => {
      const gate = await gateFirstUpdate()
      memory.clear()

      const demotion = asUser(first, '/api/auth/admin/set-role', { userId: second.id, role: 'user' })
      await gate.reached
      const holder = await lockHolderPid(db)
      expect(holder).toBeNumber()
      await db.execute(sql`select pg_terminate_backend(${holder})`)
      const countered = await fromOtherInstance(second, secondPath, first.id)
      gate.open()
      const demoted = await demotion

      expect(countered.status).toBe(200)
      expect(demoted.status).toBe(500)
      expect(await superAdminIds([first.id, second.id])).toEqual([second.id])
      // The voided change was never reported.
      expect(memory.find('audit.user.role_changed').filter((event) => event.userId === second.id)).toEqual([])
    })
  })

  test('concurrent role changes of one user audit an unbroken from/to chain', async () => {
    const first = await createUser('super_admin')
    const second = await createUser('super_admin')
    const target = await createUser()
    const gate = await gateFirstUpdate()
    memory.clear()

    const toAdmin = asUser(first, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })
    await gate.reached
    const toSuperAdmin = asUser(second, '/api/auth/admin/set-role', { userId: target.id, role: 'super_admin' })
    await waitFor(async () => userMutationLock.waiting() === 1, 'the second request waits for its turn')
    gate.open()
    expect((await toAdmin).status).toBe(200)
    expect((await toSuperAdmin).status).toBe(200)

    expect(memory.find('audit.user.role_changed')).toEqual([
      expect.objectContaining({ userId: target.id, from: 'user', to: 'admin', actorId: first.id }),
      expect.objectContaining({ userId: target.id, from: 'admin', to: 'super_admin', actorId: second.id }),
    ])
  })
})

describe.skipIf(!ready)('user mutation lock (needs the test PostgreSQL)', () => {
  test('a server-side role change outside the lock is refused; inside it, it runs', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    const call = () =>
      auth.api.setRole({ body: { userId: target.id, role: 'admin' }, headers: new Headers({ cookie: superAdmin.cookie }) })

    await expect(call()).rejects.toThrow('must run inside userMutationLock.run()')
    expect((await storedUser(target.id))?.role).toBe('user')

    await userMutationLock.run(call)
    expect((await storedUser(target.id))?.role).toBe('admin')
  })

  // The mount matches the exact path. Better Auth 1.7.15 does not route other spellings either.
  test.each(['/api/auth/admin/set-role/', '/api/auth/admin/SET-ROLE'])('%s is not routed, so nothing changes', async (path) => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()

    const response = await asUser(superAdmin, path, { userId: target.id, role: 'admin' })

    expect(response.status).toBe(404)
    expect((await storedUser(target.id))?.role).toBe('user')
  })

  // Waiting requests take no database connection, and callers the endpoint would refuse never queue,
  // so a paused holder and a crowd of callers leave the pool to everyone else.
  test('a paused holder and a full queue leave the database pool usable', async () => {
    const holder = await createUser('super_admin')
    const queued = await createUser('super_admin')
    const nobody = await createUser()
    const targets = await Promise.all(Array.from({ length: 12 }, () => createUser()))
    const gate = await gateFirstUpdate()

    const held = asUser(holder, '/api/auth/admin/set-role', { userId: nobody.id, role: 'admin' })
    await gate.reached

    const guests = await Promise.all(targets.map((target) => authPost('/api/auth/admin/ban-user', { userId: target.id })))
    expect(guests.map((response) => response.status)).toEqual(targets.map(() => 401))
    const plainUsers = await Promise.all(targets.map((target) => asUser(nobody, '/api/auth/admin/ban-user', { userId: target.id })))
    expect(plainUsers.map((response) => response.status)).toEqual(targets.map(() => 403))
    expect(userMutationLock.waiting()).toBe(0)

    const admins = targets.map((target) => asUser(queued, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' }))
    await waitFor(async () => userMutationLock.waiting() === targets.length, 'every admin request is queued')
    const unrelated = await Promise.race([
      db.execute(sql`select 1 as one`).then(() => 'answered'),
      Bun.sleep(2000).then(() => 'starved'),
    ])
    expect(unrelated).toBe('answered')

    gate.open()
    expect((await held).status).toBe(200)
    expect((await Promise.all(admins)).map((response) => response.status)).toEqual(targets.map(() => 200))
  }, 15_000)

  test('another instance holding the lock too long gets a 503 USER_MUTATION_BUSY, and nothing changes', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const holding = otherInstance.run(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise

    const response = await asUser(superAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })
    release.resolve()
    await holding

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.json()).toMatchObject({ code: 'USER_MUTATION_BUSY' })
    expect((await storedUser(target.id))?.role).toBe('user')
  }, 10_000)

  test('the in-process queue is bounded, and a waiter gives up after its wait', async () => {
    const lock = createUserMutationLock({ maxWaiters: 1, waitMs: 200 })
    const release = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const holding = lock.run(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise

    const waiting = lock.run(async () => 'ran')
    await expect(lock.run(async () => 'ran')).rejects.toBeInstanceOf(UserMutationBusyError)
    await expect(waiting).rejects.toBeInstanceOf(UserMutationBusyError)
    expect(lock.waiting()).toBe(0)

    release.resolve()
    await holding
    expect(await lock.run(async () => 'ran')).toBe('ran')
  })

  test('the lock is released when the endpoint fails', async () => {
    const superAdmin = await createUser('super_admin')
    const target = await createUser()

    expect((await asUser(superAdmin, '/api/auth/admin/set-role', { userId: 'no-such-user', role: 'admin' })).status).toBe(404)
    expect((await asUser(superAdmin, '/api/auth/admin/set-role', { userId: target.id, role: 'admin' })).status).toBe(200)
    expect(await lockWaiters(db)).toBe(0)
  })
})
