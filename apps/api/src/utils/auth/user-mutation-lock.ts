import { createDb, type Database } from '@repo/db'
import { sql } from 'drizzle-orm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { env } from '../../env'
import { withTransaction } from '../db'

// The admin endpoints that can take super_admin away from someone (set-role, ban, remove), or whose
// audit event reads the row as it was before the write (set-role, ban, unban). They run one at a
// time across every API instance, so the last-super_admin check and the audit's "before" read see
// every earlier change and nothing changes under them until the endpoint has written.
export const USER_MUTATION_PATHS: ReadonlySet<string> = new Set([
  '/admin/set-role',
  '/admin/ban-user',
  '/admin/unban-user',
  '/admin/remove-user',
])

// Any fixed value works, as long as every API instance uses the same one.
const LOCK_KEY = 710_406_412
// How long a request may wait for its turn, in this process and then for the database lock.
const WAIT_MS = 5000
// Requests allowed to wait in this process. Waiting takes no database connection; more are refused.
const MAX_WAITERS = 32
// A holder that stops talking to the database (a hung request, a paused process) loses its
// connection, so the lock and every uncommitted write go with it.
const IDLE_IN_TRANSACTION_TIMEOUT = '10s'

// PostgreSQL's `lock_not_available`, raised when `lock_timeout` runs out.
const LOCK_NOT_AVAILABLE = '55P03'

// The request could not get its turn in time. The mount answers 503 USER_MUTATION_BUSY.
export class UserMutationBusyError extends Error {
  constructor(reason: string) {
    super(`User mutation lock: ${reason}`)
    this.name = 'UserMutationBusyError'
  }
}

type AfterCommit = () => void | Promise<void>

interface Held {
  afterCommit: AfterCommit[]
}

// Shared by every lock instance: what matters to the guard in hooks.ts is that the code runs inside
// one, not which.
const held = new AsyncLocalStorage<Held>()

export function isUserMutationLockHeld(): boolean {
  return held.getStore() !== undefined
}

// Runs `fn` once the current mutation has committed, or now when there is none. Audit events of a
// write go out only if the write is kept. Outside a mutation the result of `fn` is returned, so an
// async callback can be awaited there; inside one, `run` awaits it after the commit.
export function afterUserMutationCommit(fn: AfterCommit): void | Promise<void> {
  const store = held.getStore()
  if (store === undefined) return fn()
  store.afterCommit.push(fn)
}

// Every callback runs even when an earlier one fails, so a failed cache invalidation never drops an
// audit event. The first failure is rethrown: the write is kept, but the request does not succeed.
async function runAfterCommit(callbacks: readonly AfterCommit[]): Promise<void> {
  let failure: { error: unknown } | undefined
  for (const callback of callbacks) {
    try {
      await callback()
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure !== undefined) throw failure.error
}

// One holder at a time in this process; the rest wait in memory, first come first served, so only
// the holder takes a database connection. Without this, every waiter would hold a pool connection
// while blocked on the advisory lock and could starve the holder of one.
function createAdmission(maxWaiters: number, waitMs: number) {
  let busy = false
  const waiters: Array<{ admit(): void }> = []

  function release(): void {
    const next = waiters.shift()
    if (next === undefined) busy = false
    else next.admit()
  }

  async function acquire(): Promise<() => void> {
    if (!busy) {
      busy = true
      return release
    }
    if (waiters.length >= maxWaiters) throw new UserMutationBusyError('too many requests waiting')
    return new Promise((resolve, reject) => {
      const waiter = {
        admit() {
          clearTimeout(timer)
          resolve(release)
        },
      }
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1)
        reject(new UserMutationBusyError('timed out waiting for its turn'))
      }, waitMs)
      waiters.push(waiter)
    })
  }

  return { acquire, waiting: () => waiters.length }
}

function isLockTimeout(err: unknown): boolean {
  for (let current: unknown = err; typeof current === 'object' && current !== null; current = Reflect.get(current, 'cause')) {
    if (Reflect.get(current, 'code') === LOCK_NOT_AVAILABLE) return true
  }
  return false
}

export interface UserMutationLock {
  // Runs `fn` holding the lock, in one transaction that every query made through `utils/db` joins,
  // Better Auth's included. Nested calls in the same async context reuse the held lock.
  run<T>(fn: () => Promise<T>): Promise<T>
  // Requests waiting in this process.
  waiting(): number
}

export interface UserMutationLockOptions {
  maxWaiters?: number
  waitMs?: number
  // A client with one connection, used for one mutation and then closed.
  connect?: () => Database
}

function connectOnce(): Database {
  return createDb(env.DATABASE_URL, { max: 1, onnotice: () => {} })
}

// The advisory lock is transaction-scoped and taken in the same transaction as the endpoint's reads
// and writes, so the checks and the write commit together or not at all.
//
// Each mutation gets a client of its own, closed as soon as the transaction settles. postgres-js
// 3.4.9 reconnects a connection that was lost, and a transaction handle still in use then runs its
// queries on the new connection, outside any transaction and without the lock (checked in TASK-04).
// When the lock's connection is lost the transaction fails at once while the endpoint may still be
// running; closing the client then makes its remaining queries fail instead. It also keeps the
// shared pool out of it: the holder never waits for a pool connection.
export function createUserMutationLock(options: UserMutationLockOptions = {}): UserMutationLock {
  const waitMs = options.waitMs ?? WAIT_MS
  const admission = createAdmission(options.maxWaiters ?? MAX_WAITERS, waitMs)
  const connect = options.connect ?? connectOnce

  async function holdAndRun<T>(fn: () => Promise<T>, afterCommit: AfterCommit[]): Promise<T> {
    const client = connect()
    try {
      return await client.transaction(async (tx) => {
        await tx.execute(sql`select set_config('lock_timeout', ${`${waitMs}ms`}, true),
          set_config('idle_in_transaction_session_timeout', ${IDLE_IN_TRANSACTION_TIMEOUT}, true)`)
        try {
          await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY}::bigint)`)
        } catch (err) {
          if (isLockTimeout(err)) throw new UserMutationBusyError('timed out waiting for the database lock')
          throw err
        }
        return withTransaction(tx, () => held.run({ afterCommit }, fn))
      })
    } finally {
      await client.$client.end({ timeout: 0 })
    }
  }

  return {
    async run(fn) {
      if (isUserMutationLockHeld()) return fn()
      const release = await admission.acquire()
      const afterCommit: AfterCommit[] = []
      let result: Awaited<ReturnType<typeof fn>>
      try {
        result = await holdAndRun(fn, afterCommit)
      } finally {
        release()
      }
      await runAfterCommit(afterCommit)
      return result
    },
    waiting: admission.waiting,
  }
}

export const userMutationLock: UserMutationLock = createUserMutationLock()
