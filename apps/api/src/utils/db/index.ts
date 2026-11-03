import { createDb, type Database } from '@repo/db'
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

// For graceful shutdown (TASK-13). Waits for running queries, then closes the pool.
export async function closeDb(): Promise<void> {
  await pool.$client.end()
}
