import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb, type Database } from '@repo/db'
import {
  assertTestDatabaseUrl,
  DEFAULT_TEST_DATABASE_URL,
  fixtures,
  type Fixtures,
  MIGRATION_LOCK_KEY,
  prepareTestDatabase,
  TestDatabaseGuardError,
  testDatabaseUrl,
  testDb,
} from './db'

const DEV_DATABASE_URL = 'postgres://app:hunter2@127.0.0.1:5432/app'

describe('test database guard', () => {
  test('accepts the app_test database', () => {
    expect(assertTestDatabaseUrl(DEFAULT_TEST_DATABASE_URL)).toBe(DEFAULT_TEST_DATABASE_URL)
    expect(assertTestDatabaseUrl('postgresql://ci:ci@postgres:5432/app_test')).toBeString()
    expect(assertTestDatabaseUrl(`${DEFAULT_TEST_DATABASE_URL}?sslmode=disable&connect_timeout=5`)).toBeString()
  })

  test.each([
    ['the dev database', DEV_DATABASE_URL],
    ['a database that only starts with app_test', 'postgres://app:hunter2@127.0.0.1:5442/app_test_old'],
    ['no database name', 'postgres://app:hunter2@127.0.0.1:5442'],
    ['another protocol', 'mysql://app:hunter2@127.0.0.1:5442/app_test'],
    ['something that is not a URL', 'app_test'],
    // postgres-js sends these as startup parameters, which override the database in the path.
    ['a database query parameter', 'postgres://app:hunter2@127.0.0.1:5442/app_test?database=app'],
    ['a user query parameter', 'postgres://app:hunter2@127.0.0.1:5442/app_test?user=postgres'],
    ['an options query parameter', 'postgres://app:hunter2@127.0.0.1:5442/app_test?options=-csearch_path%3Dhunter2'],
  ])('refuses %s without echoing the password', (_, url) => {
    expect(() => assertTestDatabaseUrl(url)).toThrow(TestDatabaseGuardError)
    try {
      assertTestDatabaseUrl(url)
    } catch (error) {
      expect(String(error)).not.toContain('hunter2')
    }
  })

  test('TEST_DATABASE_URL wins over the docker-compose.test.yml default', () => {
    expect(testDatabaseUrl({})).toBe(DEFAULT_TEST_DATABASE_URL)
    expect(testDatabaseUrl({ TEST_DATABASE_URL: 'postgres://ci:ci@db:5432/app_test' })).toBe('postgres://ci:ci@db:5432/app_test')
    expect(() => testDatabaseUrl({ TEST_DATABASE_URL: DEV_DATABASE_URL })).toThrow(TestDatabaseGuardError)
  })

  test('refuses before connecting or migrating', async () => {
    // Port 1 refuses connections: reaching it would fail with a connection error, not the guard.
    await expect(prepareTestDatabase('postgres://app:hunter2@127.0.0.1:1/app')).rejects.toThrow(TestDatabaseGuardError)
  })

  test('the preload points the app at the test database and turns the other stores off', () => {
    expect(process.env.DATABASE_URL).toBe(testDatabaseUrl())
    expect(process.env.REDIS_URL).toBe('')
    expect(process.env.LOG_MONGO_URL).toBe('')
  })
})

// Other workers may hold the lock for a moment while they migrate, so this retries briefly.
async function migrationLockIsFree(): Promise<boolean> {
  const probe = createDb(testDatabaseUrl())
  const connection = await probe.$client.reserve()
  try {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const [row] = await connection<{ locked: boolean }[]>`select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as locked`
      if (row?.locked === true) {
        await connection`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`
        return true
      }
      await Bun.sleep(100)
    }
    return false
  } finally {
    connection.release()
    await probe.$client.end()
  }
}

// Needs the PostgreSQL of docker-compose.test.yml; it fails, never skips, when it is not running.
describe('test database (app_test)', () => {
  let db: Database
  // Undefined when beforeAll failed (test PostgreSQL down), so afterAll has nothing to clean.
  let scope: Fixtures | undefined
  let other: Fixtures | undefined

  beforeAll(async () => {
    db = await testDb()
    scope = fixtures(db)
    other = fixtures(db)
  })

  afterAll(async () => {
    await scope?.cleanup()
    await other?.cleanup()
  })

  test('is the migrated app_test database', async () => {
    const [row] = await db.$client<{ name: string; post: string | null; user: string | null }[]>`
      select current_database() as name, to_regclass('public.post')::text as post, to_regclass('public.user')::text as user`

    expect(row).toEqual({ name: 'app_test', post: 'post', user: '"user"' })
  })

  test('migrating again is a no-op', async () => {
    const again = await prepareTestDatabase(testDatabaseUrl())
    await again.$client.end()
  })

  test('test processes preparing at the same time both succeed', async () => {
    const both = await Promise.all([prepareTestDatabase(testDatabaseUrl()), prepareTestDatabase(testDatabaseUrl())])
    await Promise.all(both.map((prepared) => prepared.$client.end()))
  })

  test('waiting for another migrating process is bounded', async () => {
    const holder = createDb(testDatabaseUrl())
    const connection = await holder.$client.reserve()
    try {
      await connection`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`
      await expect(prepareTestDatabase(testDatabaseUrl(), { lockTimeoutMs: 300 })).rejects.toThrow(/Timed out after 300ms waiting/)
    } finally {
      await connection`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`
      connection.release()
      await holder.$client.end()
    }
  })

  test.each([
    ['fails', [process.execPath, '-e', 'process.exit(3)'], /Migrating app_test failed/],
    ['hangs', [process.execPath, '-e', 'await Bun.sleep(30_000)'], /timed out after 300ms and was stopped/],
  ])('a migration that %s fails the run and releases the lock', async (_, migrateCommand, message) => {
    const started = Date.now()
    await expect(prepareTestDatabase(testDatabaseUrl(), { migrateCommand, migrationTimeoutMs: 300 })).rejects.toThrow(message)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(await migrationLockIsFree()).toBe(true)
  })

  test('a fixture whose insert fails never deletes the row that already had that id', async () => {
    const id = `test-collision-${crypto.randomUUID()}`
    const owner = fixtures(db, () => id)
    const intruder = fixtures(db, () => id)
    try {
      await owner.user()
      await expect(intruder.user()).rejects.toThrow()
      await intruder.cleanup()

      const left = await db.$client<{ id: string }[]>`select id from "user" where id = ${id}`
      expect(left.map((row) => row.id)).toEqual([id])
    } finally {
      await owner.cleanup()
    }
  })

  test('fixtures are unique per scope and cleanup removes only their own rows', async () => {
    if (scope === undefined || other === undefined) throw new Error('fixtures were not created')
    const mine = await scope.user({ role: 'admin' })
    const theirs = await other.user()

    expect(mine).toMatchObject({ role: 'admin', email: `test+${scope.run}-1@example.test` })
    expect(theirs.email).not.toBe(mine.email)

    await scope.cleanup()

    const left = await db.$client<{ id: string }[]>`select id from "user" where id in ${db.$client([mine.id, theirs.id])}`
    expect(left.map((row) => row.id)).toEqual([theirs.id])
  })
})
