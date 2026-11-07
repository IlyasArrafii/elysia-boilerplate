import { afterAll, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { account, session, user, type Database } from '@repo/db'
import { count, inArray } from 'drizzle-orm'
import { db } from '../../../src/utils/db'
import { authPost, PASSWORD, prepareTestDatabase, testUsers, uniqueEmail } from './setup'

// testUsers() removes exactly the users a test file signed up, so the shared test database does not
// grow with every run (and with it the super_admins that withOnlySuperAdmins demotes and restores).

const ready = await prepareTestDatabase()

const API_ROOT = resolve(import.meta.dir, '../../..')
// Relative to API_ROOT, so the child picks up bunfig.toml and its preload like `bun run test` does.
const FIXTURE = './tests/utils/auth/test-users.fixture.ts'
// The child compiles the app and signs up three users before it reports.
const CHILD_TIMEOUT_MS = 60_000

const mine = testUsers()
const theirs = testUsers()

afterAll(async () => {
  await mine.cleanup()
  await theirs.cleanup()
})

async function rowsOf(ids: string[]): Promise<{ users: number; sessions: number; accounts: number }> {
  const [users] = await db.select({ n: count() }).from(user).where(inArray(user.id, ids))
  const [sessions] = await db.select({ n: count() }).from(session).where(inArray(session.userId, ids))
  const [accounts] = await db.select({ n: count() }).from(account).where(inArray(account.userId, ids))
  return { users: users?.n ?? 0, sessions: sessions?.n ?? 0, accounts: accounts?.n ?? 0 }
}

// A sign-up that bypasses createUser, as the sign-up, OAuth and logger tests do their own.
async function signUpWithoutCreateUser(): Promise<string> {
  const response = await authPost('/api/auth/sign-up/email', { email: uniqueEmail(), password: PASSWORD, name: 'Signed Up' })
  expect(response.status).toBe(200)
  return ((await response.json()) as { user: { id: string } }).user.id
}

describe('cleanup with no users', () => {
  test('never touches the database, so a run without PostgreSQL does not wait on a connection', async () => {
    const touched: string[] = []
    // Any use of the database, a query or otherwise, is recorded and fails.
    const offline = new Proxy({}, {
      get(_target, property) {
        touched.push(String(property))
        throw new Error(`cleanup used db.${String(property)}`)
      },
    }) as Database

    await testUsers(offline).cleanup()

    expect(touched).toEqual([])
  })
})

describe.skipIf(!ready)('cleanup (needs the test PostgreSQL)', () => {
  test("deletes this scope's users with their sessions and accounts, by id, and leaves another scope's alone", async () => {
    const superAdmin = await mine.createUser('super_admin')
    const plain = await mine.createUser()
    const other = await theirs.createUser('super_admin')
    const ids = [superAdmin.id, plain.id]
    const before = await rowsOf(ids)
    expect(before.users).toBe(2)
    expect(before.sessions).toBeGreaterThan(0)
    expect(before.accounts).toBe(2)

    await mine.cleanup()

    expect(await rowsOf(ids)).toEqual({ users: 0, sessions: 0, accounts: 0 })
    const untouched = await rowsOf([other.id])
    expect(untouched.users).toBe(1)
    expect(untouched.sessions).toBeGreaterThan(0)
    expect(untouched.accounts).toBe(1)
  })

  test("a tracked user is deleted with the scope's own, by id, and another scope's tracked user is left alone", async () => {
    const signedUp = await signUpWithoutCreateUser()
    mine.track(signedUp)
    const created = await mine.createUser()
    const other = await signUpWithoutCreateUser()
    theirs.track(other)
    const ids = [signedUp, created.id]
    // The tracked user's own session and account, so the cascade below is proven for it too.
    expect(await rowsOf([signedUp])).toEqual({ users: 1, sessions: 1, accounts: 1 })
    const before = await rowsOf(ids)
    expect(before.users).toBe(2)
    expect(before.sessions).toBeGreaterThan(1)
    expect(before.accounts).toBe(2)

    await mine.cleanup()

    expect(await rowsOf(ids)).toEqual({ users: 0, sessions: 0, accounts: 0 })
    const untouched = await rowsOf([other])
    expect(untouched.users).toBe(1)
    expect(untouched.sessions).toBe(1)
    expect(untouched.accounts).toBe(1)
  })

  test(
    "a test file's users are gone once it has run, those of a failing test and of beforeAll included",
    async () => {
      const child = Bun.spawn({
        cmd: [process.execPath, 'test', FIXTURE],
        cwd: API_ROOT,
        env: { ...process.env, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
        // Stop a hung child before this test times out, so the checks below still report and the
        // finally block still deletes whatever users it printed.
        timeout: CHILD_TIMEOUT_MS - 5_000,
        killSignal: 'SIGKILL',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const output = stdout + stderr
      // Whole stdout lines only: the failure report on stderr quotes the fixture's source, logging call included.
      const ids = [...stdout.matchAll(/^created-user ([\w-]+)\r?$/gm)].map((match) => match[1] ?? '')
      try {
        // Three users created, the failing test failed, and the beforeAll user outlived it.
        expect(ids, output).toHaveLength(3)
        expect(output).toContain('fails on purpose')
        expect(output).toContain('kept-user-present')
        expect(exitCode, output).toBe(1)

        expect(await rowsOf(ids)).toEqual({ users: 0, sessions: 0, accounts: 0 })
      } finally {
        // Only when the check above failed is there anything left to remove.
        if (ids.length > 0) await db.delete(user).where(inArray(user.id, ids))
      }
    },
    CHILD_TIMEOUT_MS,
  )
})
