import { resolve } from 'node:path'
import { createDb, user, type Database } from '@repo/db'

// The PostgreSQL of docker-compose.test.yml (TESTING.md §3). TEST_DATABASE_URL overrides it, for
// example for a CI service container, but it must still name the test database.
export const DEFAULT_TEST_DATABASE_URL = 'postgres://app:app_dev@127.0.0.1:5442/app_test'
export const TEST_DATABASE_NAME = 'app_test'

const PACKAGES_DB = resolve(import.meta.dir, '../../../../packages/db')
const POSTGRES_PROTOCOLS = ['postgres:', 'postgresql:']
// postgres-js sends every other query parameter as a startup parameter, where `database`, `user`
// or `options` would silently retarget the connection. Only connection tuning is allowed.
const ALLOWED_URL_PARAMETERS = ['ssl', 'sslmode', 'sslrootcert', 'connect_timeout', 'application_name']
// Any fixed number works: it only has to be the same in every test process sharing the database.
export const MIGRATION_LOCK_KEY = 18_018
const LOCK_POLL_MS = 100

export class TestDatabaseGuardError extends Error {
  override readonly name = 'TestDatabaseGuardError'
}

// Runs before any connection is opened. Messages name the host, database and parameter names but
// never the URL or a parameter value, which can carry a password.
export function assertTestDatabaseUrl(url: string): string {
  if (!URL.canParse(url)) throw new TestDatabaseGuardError('The test database URL is not a valid URL')

  const parsed = new URL(url)
  if (!POSTGRES_PROTOCOLS.includes(parsed.protocol)) {
    throw new TestDatabaseGuardError('The test database URL must be a postgres:// or postgresql:// URL')
  }
  const name = decodeURIComponent(parsed.pathname.slice(1))
  if (name !== TEST_DATABASE_NAME) {
    throw new TestDatabaseGuardError(
      `Refusing to run tests against database "${name}" on ${parsed.host}: tests only ever use "${TEST_DATABASE_NAME}"`,
    )
  }
  const unsafe = [...parsed.searchParams.keys()].filter((key) => !ALLOWED_URL_PARAMETERS.includes(key))
  if (unsafe.length > 0) {
    throw new TestDatabaseGuardError(
      `The test database URL may only carry ${ALLOWED_URL_PARAMETERS.join(', ')} parameters; refusing ${unsafe.join(', ')}`,
    )
  }
  return url
}

export function testDatabaseUrl(environment: Record<string, string | undefined> = process.env): string {
  return assertTestDatabaseUrl(environment.TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL)
}

export interface PrepareOptions {
  // How long to wait for another test process that is migrating the same database.
  lockTimeoutMs?: number
  migrationTimeoutMs?: number
  // Defaults to the command developers run, so tests and dev never apply migrations differently.
  migrateCommand?: string[]
}

async function runMigrations(url: string, command: string[], timeoutMs: number): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd: PACKAGES_DB,
    env: { ...process.env, DATABASE_URL: url },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (child.signalCode !== null) {
      throw new Error(`Migrating ${TEST_DATABASE_NAME} timed out after ${timeoutMs}ms and was stopped:\n${stdout}${stderr}`)
    }
    if (exitCode !== 0) throw new Error(`Migrating ${TEST_DATABASE_NAME} failed:\n${stdout}${stderr}`)
  } finally {
    // The caller unlocks right after this returns, so no migration may still be running by then.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
  }
}

type Connection = Awaited<ReturnType<Database['$client']['reserve']>>

// Polled rather than a blocking pg_advisory_lock, so a stuck migration elsewhere fails this run
// with a clear message instead of hanging it.
async function acquireMigrationLock(connection: Connection, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const [row] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as locked`
    if (row?.locked === true) return
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for another test process to finish migrating ${TEST_DATABASE_NAME}`)
    }
    await Bun.sleep(LOCK_POLL_MS)
  }
}

// Checks which database the server actually opened, then migrates. The advisory lock serialises
// test processes that start together on a fresh database: drizzle's migrator would otherwise run the
// same migration twice and fail. The lock is cooperative: a migration started by hand bypasses it,
// and if this process dies mid-migration PostgreSQL releases the lock while the child may still run.
export async function prepareTestDatabase(url: string, options: PrepareOptions = {}): Promise<Database> {
  const {
    lockTimeoutMs = 60_000,
    migrationTimeoutMs = 60_000,
    migrateCommand = [process.execPath, 'run', 'db:migrate'],
  } = options
  assertTestDatabaseUrl(url)
  const db = createDb(url)
  try {
    const connection = await db.$client.reserve().catch((error: unknown) => {
      const { host } = new URL(url)
      throw new Error(
        `Test PostgreSQL is not reachable on ${host}. Start it with: docker compose -f docker-compose.test.yml up -d --wait postgres`,
        { cause: error },
      )
    })
    try {
      const [row] = await connection<{ name: string }[]>`select current_database() as name`
      if (row?.name !== TEST_DATABASE_NAME) {
        throw new TestDatabaseGuardError(`Connected to "${row?.name}" instead of "${TEST_DATABASE_NAME}"; refusing to migrate`)
      }
      await acquireMigrationLock(connection, lockTimeoutMs)
      try {
        await runMigrations(url, migrateCommand, migrationTimeoutMs)
      } finally {
        await connection`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`
      }
    } finally {
      connection.release()
    }
    return db
  } catch (error) {
    await db.$client.end()
    throw error
  }
}

let shared: Promise<Database> | undefined

// One pool, migrated once per `bun test` process. Never closed by a test file: files share it and
// the runner exits when the run ends.
export function testDb(): Promise<Database> {
  shared ??= prepareTestDatabase(testDatabaseUrl())
  return shared
}

type NewUser = typeof user.$inferInsert
type UserRow = typeof user.$inferSelect

export interface Fixtures {
  // A unique token for this scope, for names and emails that must not collide with other runs.
  readonly run: string
  user(overrides?: Partial<Omit<NewUser, 'id'>>): Promise<UserRow>
  // Deletes only the rows this scope created (posts, sessions and accounts follow by cascade).
  cleanup(): Promise<void>
}

// The test database is shared by parallel runs and other workers, so tests never truncate it:
// each file creates its own rows and removes exactly those. `newId` exists for this helper's own tests.
export function fixtures(db: Database, newId: () => string = () => `test-${crypto.randomUUID()}`): Fixtures {
  const run = crypto.randomUUID()
  const userIds: string[] = []
  let count = 0

  return {
    run,
    async user(overrides = {}) {
      count++
      const [row] = await db
        .insert(user)
        .values({ name: `Test User ${count}`, email: `test+${run}-${count}@example.test`, role: 'user', ...overrides, id: newId() })
        .returning()
      if (row === undefined) throw new Error('Inserting a fixture user returned no row')
      // Recorded only once inserted: an id whose insert failed (say, because it already exists)
      // belongs to someone else, and cleanup must never delete it.
      userIds.push(row.id)
      return row
    },
    async cleanup() {
      if (userIds.length === 0) return
      await db.$client`delete from "user" where id in ${db.$client(userIds)}`
      userIds.length = 0
    },
  }
}
