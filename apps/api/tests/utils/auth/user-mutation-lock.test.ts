import { describe, expect, test } from 'bun:test'
import { user } from '@repo/db'
import { eq } from 'drizzle-orm'
import { afterUserMutationCommit, createUserMutationLock } from '../../../src/utils/auth/user-mutation-lock'
import { db } from '../../../src/utils/db'
import { createUser, prepareTestDatabase, storedUser } from './setup'

// The after-commit callbacks of user-mutation-lock.ts (posts clears its cache there when a user is
// removed, TASK-08). The lock's queueing and the guards are covered in super-admins.test.ts.

const ready = await prepareTestDatabase()

describe('afterUserMutationCommit outside a mutation', () => {
  test('runs the callback at once and hands back its promise', async () => {
    const seen: string[] = []

    const pending = afterUserMutationCommit(async () => {
      seen.push('ran')
    })
    expect(seen).toEqual(['ran'])
    await pending
  })
})

describe.skipIf(!ready)('afterUserMutationCommit in a mutation (needs the test PostgreSQL)', () => {
  test('waits for the commit, and run() awaits it before returning', async () => {
    const lock = createUserMutationLock()
    const target = await createUser()
    let seenName: string | undefined

    await lock.run(async () => {
      await db.update(user).set({ name: 'Renamed in the lock' }).where(eq(user.id, target.id))
      afterUserMutationCommit(async () => {
        // The shared pool, outside the transaction: the new name shows only once it is committed.
        await Bun.sleep(5)
        seenName = (await storedUser(target.id))?.name
      })
    })

    expect(seenName).toBe('Renamed in the lock')
  })

  test('a failing callback fails run() after every callback ran; the write is kept', async () => {
    const lock = createUserMutationLock()
    const target = await createUser()
    const failure = new Error('cache unavailable')
    const seen: string[] = []

    const run = lock.run(async () => {
      await db.update(user).set({ name: 'Kept despite the failure' }).where(eq(user.id, target.id))
      afterUserMutationCommit(async () => {
        seen.push('first')
        throw failure
      })
      afterUserMutationCommit(() => {
        seen.push('second')
      })
      return 'written'
    })

    await expect(run).rejects.toBe(failure)
    expect(seen).toEqual(['first', 'second'])
    expect((await storedUser(target.id))?.name).toBe('Kept despite the failure')
  })

  test('nothing runs when the mutation rolls back', async () => {
    const lock = createUserMutationLock()
    const seen: string[] = []

    const run = lock.run(async () => {
      afterUserMutationCommit(() => {
        seen.push('ran')
      })
      throw new Error('endpoint failed')
    })

    await expect(run).rejects.toThrow('endpoint failed')
    expect(seen).toEqual([])
  })
})
