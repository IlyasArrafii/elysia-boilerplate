import { afterAll, describe, expect, test } from 'bun:test'
import { user } from '@repo/db'
import { inArray, sql } from 'drizzle-orm'
import { createUserMutationLock } from '../../src/utils/auth/user-mutation-lock'
import { fixtures, testDb } from './db'
import { lockHolderPid, lockWaiters, waitFor, withOnlySuperAdmins } from './user-mutation'

const db = await testDb()
const scope = fixtures(db)
// LOCK_KEY in src/utils/auth/user-mutation-lock.ts.
const USER_MUTATION_LOCK_KEY = 710_406_412
// Next to it, so only an exact match on the key leaves it out.
const OTHER_LOCK_KEY = USER_MUTATION_LOCK_KEY + 1

afterAll(() => scope.cleanup())

async function roles(ids: string[]): Promise<(string | null)[]> {
  const rows = await db.select({ id: user.id, role: user.role }).from(user).where(inArray(user.id, ids))
  return ids.map((id) => rows.find((row) => row.id === id)?.role ?? null)
}

// Takes `key` in a transaction, waiting for it if need be, and keeps it until `release()`. `held`
// resolves with the backend's pid once the lock is taken.
function holdAdvisoryLock(key: number) {
  const held = Promise.withResolvers<number | undefined>()
  const release = Promise.withResolvers<void>()
  const done = db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${key}::bigint)`)
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
    held.resolve(row?.pid)
    await release.promise
  })
  return { held: held.promise, release: () => release.resolve(), done }
}

describe('withOnlySuperAdmins', () => {
  test('leaves only the given super_admins while it runs and returns what the callback returns', async () => {
    const kept = await scope.user({ role: 'super_admin' })
    const other = await scope.user({ role: 'super_admin' })

    const result = await withOnlySuperAdmins(db, [kept.id], async () => roles([kept.id, other.id]))

    expect(result).toEqual(['super_admin', 'user'])
  })

  test('puts every demoted role back as it was, even when the callback fails', async () => {
    const kept = await scope.user({ role: 'super_admin' })
    const other = await scope.user({ role: 'super_admin' })
    const mixed = await scope.user({ role: 'admin,super_admin' })

    const run = withOnlySuperAdmins(db, [kept.id], async () => {
      throw new Error('the test failed')
    })

    await expect(run).rejects.toThrow('the test failed')
    expect(await roles([kept.id, other.id, mixed.id])).toEqual(['super_admin', 'super_admin', 'admin,super_admin'])
  })
})

describe('user mutation lock in pg_locks', () => {
  test('counts a waiter for the user mutation lock and finds its holder', async () => {
    const holder = holdAdvisoryLock(USER_MUTATION_LOCK_KEY)
    const holderPid = await holder.held
    const otherInstance = createUserMutationLock()
    const waiting = otherInstance.run(async () => 'ran')
    try {
      await waitFor(async () => (await lockWaiters(db)) === 1, 'the other instance waits for the lock')
      expect(holderPid).toBeNumber()
      expect(await lockHolderPid(db)).toBe(holderPid)
    } finally {
      holder.release()
      await holder.done
    }
    expect(await waiting).toBe('ran')
  })

  test('ignores other advisory locks, held or awaited', async () => {
    const holder = holdAdvisoryLock(OTHER_LOCK_KEY)
    const holderPid = await holder.held
    const waiter = holdAdvisoryLock(OTHER_LOCK_KEY)
    try {
      await waitFor(async () => {
        const rows = await db.execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_locks
              where locktype = 'advisory' and objid = ${OTHER_LOCK_KEY} and not granted`,
        )
        return (rows[0]?.waiting ?? 0) > 0
      }, 'the second transaction waits for the other lock')

      expect(holderPid).toBeNumber()
      // Other test runs share the database and may hold the user mutation lock now, never this one.
      expect(await lockHolderPid(db)).not.toBe(holderPid)
      // Only the key tells runs apart, so this fails in the rare moment another run is queued on the
      // user mutation lock. That flake is accepted.
      expect(await lockWaiters(db)).toBe(0)
    } finally {
      holder.release()
      waiter.release()
      await Promise.all([holder.done, waiter.done])
    }
  })
})
