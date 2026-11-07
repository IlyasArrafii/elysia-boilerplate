import { user, type Database } from '@repo/db'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolve } from 'node:path'
import { env } from '../../../src/env'
import { db } from '../../../src/utils/db'
import { jsonPost, request } from '../../helpers/app'
import { clientIp, uniqueIp } from '../../helpers/ip'

// Auth-route support for these tests only. TASK-18 owns the shared `helpers/db.ts` and
// `helpers/auth.ts` (TESTING.md §3); this can move there once they exist.

const MIGRATIONS = resolve(import.meta.dir, '../../../../../packages/db/migrations')
const PROBE_TIMEOUT_MS = 1000

// The web origin Better Auth trusts in tests (env.ts default), sent as `Origin` like a browser would.
export const WEB_ORIGIN = env.WEB_URL
export const PASSWORD = 'correct-horse-battery'

// Only a database whose name ends in `_test` is ever written to, so a shell DATABASE_URL pointing at
// a development database makes these tests skip instead of filling it with users.
function isTestDatabase(url: string): boolean {
  return new URL(url).pathname.endsWith('_test')
}

// A TCP probe first: postgres-js waits 30 s for a connection that is refused or dropped.
async function isListening(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url)
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS)
    Bun.connect({
      hostname,
      port: Number(port || 5432),
      socket: {
        open(socket) {
          clearTimeout(timer)
          socket.end()
          done(true)
        },
        connectError() {
          clearTimeout(timer)
          done(false)
        },
        data() {},
      },
    }).catch(() => {
      clearTimeout(timer)
      done(false)
    })
  })
}

// `bun run test` must pass without the test stack: suites that need PostgreSQL skip when it is down.
export async function prepareTestDatabase(): Promise<boolean> {
  if (!isTestDatabase(env.DATABASE_URL) || !(await isListening(env.DATABASE_URL))) return false
  await migrate(db, { migrationsFolder: MIGRATIONS })
  return true
}

// Every caller gets its own client IP, so rate limits from one test never reach another.
export { clientIp, uniqueIp }

export function uniqueEmail(): string {
  return `auth-${crypto.randomUUID()}@example.test`
}

export function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: WEB_ORIGIN, ...clientIp(), ...extra }
}

export function authPost(path: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return request(...jsonPost(path, body, headers(extra)))
}

export function sessionCookie(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('app.session_token='))
  if (cookie === undefined) throw new Error(`No session cookie in the ${response.status} response`)
  return cookie.split(';')[0] ?? ''
}

export interface TestUser {
  id: string
  email: string
  cookie: string
}

export interface TestUsers {
  // Signs up, optionally sets the role straight in the database (as an operator or the seed would),
  // then signs in again so the session carries the role.
  createUser(role?: string | null): Promise<TestUser>
  // For a user the test signed up itself (a sign-up or OAuth test): `cleanup()` deletes it too. Pass the
  // id from the sign-up's own response, or from a lookup by the exact unique address the test signed up
  // with; never one found by role or an email pattern, which could belong to another run.
  track(id: string): void
  // Deletes only the users this scope signed up or tracked (their sessions and accounts follow by cascade).
  cleanup(): Promise<void>
}

// The test database is shared by parallel runs and other worktrees, so, as with `fixtures()`, each test
// file removes exactly the users it signed up, by id, once its tests are done (failed ones included):
//
//   const { createUser, track, cleanup } = testUsers()
//   afterAll(cleanup)
//
// A test that signs up on its own calls `track(id)` as soon as it has the new user's id, before its
// assertions, so the user is removed even when one of them fails.
//
// `database` exists for this helper's own tests; it must be the database the app signs users up in.
export function testUsers(database: Database = db): TestUsers {
  const userIds: string[] = []

  return {
    async createUser(role) {
      const email = uniqueEmail()
      const signUp = await authPost('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'Test User' })
      if (signUp.status !== 200) throw new Error(`Sign-up failed with ${signUp.status}: ${await signUp.text()}`)
      const { user: created } = (await signUp.json()) as { user: { id: string } }
      // Recorded as soon as the user exists, so one whose role update or sign-in fails is removed too.
      userIds.push(created.id)

      if (role !== undefined) await database.update(user).set({ role }).where(eq(user.id, created.id))
      const signIn = await authPost('/api/auth/sign-in/email', { email, password: PASSWORD })
      if (signIn.status !== 200) throw new Error(`Sign-in failed with ${signIn.status}: ${await signIn.text()}`)
      return { id: created.id, email, cookie: sessionCookie(signIn) }
    },
    track(id) {
      userIds.push(id)
    },
    // Sends no query when nothing was created, so a run without PostgreSQL never waits on a connection.
    async cleanup() {
      if (userIds.length === 0) return
      await database.delete(user).where(inArray(user.id, userIds))
      userIds.length = 0
    },
  }
}

export async function storedUser(id: string) {
  const [row] = await db.select().from(user).where(eq(user.id, id))
  return row
}
