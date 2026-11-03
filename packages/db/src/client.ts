import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type DbOptions = postgres.Options<Record<string, postgres.PostgresType>>

/**
 * Opens a connection pool lazily (postgres-js dials on the first query). The caller owns the pool and
 * closes it with `db.$client.end()`. The URL is a parameter because only the app reads the environment;
 * `options` are postgres-js options (for example `max`), the driver defaults when absent.
 */
export function createDb(url: string, options: DbOptions = {}) {
  return drizzle({ client: postgres(url, options), schema })
}

export type Database = ReturnType<typeof createDb>
