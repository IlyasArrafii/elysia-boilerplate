import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/**
 * Opens a connection pool lazily (postgres-js dials on the first query). The caller owns the pool and
 * closes it with `db.$client.end()`. The URL is a parameter because only the app reads the environment.
 */
export function createDb(url: string) {
  return drizzle({ client: postgres(url), schema })
}

export type Database = ReturnType<typeof createDb>
