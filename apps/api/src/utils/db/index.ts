import { createDb, type Database } from '@repo/db'
import { sql } from 'drizzle-orm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { env } from '../../env'

// The API's one PostgreSQL pool. postgres-js dials on the first query, so importing this opens no
// connection.
const pool: Database = createDb(env.DATABASE_URL)

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

const scope = new AsyncLocalStorage<Transaction>()

// What every module and Better Auth's Drizzle adapter query through. Inside `withTransaction` every
// query, including the ones Better Auth makes, runs on that transaction; elsewhere on the pool.
// Better Auth 1.7.15 cannot be handed a transaction per request (its adapter is built once), so the
// transaction is picked per property access instead. A transaction is a full Drizzle database except
// for `$client`, which only shutdown reads, from the pool.
export const db: Database = new Proxy(pool, {
  get(target, property) {
    const current: object = scope.getStore() ?? target
    const value: unknown = Reflect.get(current, property)
    return typeof value === 'function' ? value.bind(current) : value
  },
})

// Runs `fn` with `db` bound to `tx` until `fn` settles.
export function withTransaction<T>(tx: Transaction, fn: () => Promise<T>): Promise<T> {
  return scope.run(tx, fn)
}

export type DbState = 'up' | 'down'

const DEFAULT_PROBE_TIMEOUT_MS = 1000

// postgres-js waits up to 30 s to connect and the timer below does not cancel the query, so a
// frequent health check against a stalled server would pile up queries. Callers share the one in
// flight until it settles, so a stalled server holds one pool connection, not one per probe.
let pendingPing: Promise<DbState> | undefined

// For `GET /api/health` (TASK-13). Never rejects: anything but an answer within the timeout is
// `down`. It asks the shared pool, never a transaction that `db` may be bound to.
export async function probeDb(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<DbState> {
  pendingPing ??= pool
    .execute(sql`select 1`)
    .then(
      () => 'up' as const,
      () => 'down' as const,
    )
    .finally(() => {
      pendingPing = undefined
    })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'down'>((resolve) => {
    timer = setTimeout(() => resolve('down'), timeoutMs)
  })
  try {
    return await Promise.race([pendingPing, timeout])
  } finally {
    clearTimeout(timer)
  }
}

// For graceful shutdown (TASK-13). Waits for running queries, then closes the pool. With
// `timeoutMs`, connections still busy then are terminated and it rejects, so a forced close is
// never reported as a clean one. Clients of admin mutations are their own and close themselves.
export async function closeDb(timeoutMs?: number): Promise<void> {
  if (timeoutMs === undefined) return pool.$client.end()

  // postgres-js resolves `end` after terminating at its timeout too, so this flag, set by a timer
  // created first and therefore firing first, is how a forced close is told apart.
  let forced = false
  const timer = setTimeout(() => {
    forced = true
  }, timeoutMs)
  try {
    await pool.$client.end({ timeout: timeoutMs / 1000 })
  } finally {
    clearTimeout(timer)
  }
  if (forced) throw new Error(`PostgreSQL connections were still busy after ${timeoutMs} ms and were terminated`)
}
