import { user } from '@repo/db'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { resolve } from 'node:path'
import { env } from '../../../src/env'
import { db } from '../../../src/utils/db'
import { jsonPost, request } from '../../helpers/app'
import { uniqueIp } from '../../helpers/ip'

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
export { uniqueIp }

export function uniqueEmail(): string {
  return `auth-${crypto.randomUUID()}@example.test`
}

export function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: WEB_ORIGIN, 'x-forwarded-for': uniqueIp(), ...extra }
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

// Signs up, optionally sets the role straight in the database (as an operator or the seed would),
// then signs in again so the session carries the role.
export async function createUser(role?: string | null): Promise<TestUser> {
  const email = uniqueEmail()
  const signUp = await authPost('/api/auth/sign-up/email', { email, password: PASSWORD, name: 'Test User' })
  if (signUp.status !== 200) throw new Error(`Sign-up failed with ${signUp.status}: ${await signUp.text()}`)
  const { user: created } = (await signUp.json()) as { user: { id: string } }

  if (role !== undefined) await db.update(user).set({ role }).where(eq(user.id, created.id))
  const signIn = await authPost('/api/auth/sign-in/email', { email, password: PASSWORD })
  if (signIn.status !== 200) throw new Error(`Sign-in failed with ${signIn.status}: ${await signIn.text()}`)
  return { id: created.id, email, cookie: sessionCookie(signIn) }
}

export async function storedUser(id: string) {
  const [row] = await db.select().from(user).where(eq(user.id, id))
  return row
}
