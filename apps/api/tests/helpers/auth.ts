import { account, type Database } from '@repo/db'
import { env } from '../../src/env'
import { auth } from '../../src/utils/auth'
import { jsonPost, request } from './app'
import type { Fixtures } from './db'
import { uniqueIp } from './ip'

// Signed-in users for route tests (TESTING.md §3). The user is a `fixtures()` row, so it lives in the
// guarded test database and `cleanup()` removes it with its account and sessions (cascade).

export const PASSWORD = 'correct-horse-battery'

// Hashed once per process with Better Auth's own hasher: the sign-in below verifies it like any other.
let passwordHash: Promise<string> | undefined

export interface SignedInUser {
  id: string
  email: string
  // The `cookie` request header: `app.session_token=…`.
  cookie: string
}

// Better Auth checks `Origin` against `trustedOrigins` on a cookie request, as a browser would send it.
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: env.WEB_URL, 'x-forwarded-for': uniqueIp(), ...extra }
}

function sessionCookieOf(response: Response): string {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('app.session_token='))
  if (cookie === undefined) throw new Error(`No session cookie in the ${response.status} sign-in response`)
  return cookie.split(';')[0] ?? ''
}

// Signs in through `POST /api/auth/sign-in/email`, so the session is a real one.
export async function signIn(email: string, password: string = PASSWORD): Promise<string> {
  const response = await request(...jsonPost('/api/auth/sign-in/email', { email, password }, authHeaders()))
  if (response.status !== 200) throw new Error(`Sign-in failed with ${response.status}: ${await response.text()}`)
  return sessionCookieOf(response)
}

// A user with `role` stored as given (`null` and unknown or comma-separated roles included, as an
// operator could write them), a password account, and a session cookie.
export async function createUser(scope: Fixtures, db: Database, role: string | null = 'user'): Promise<SignedInUser> {
  const row = await scope.user({ role })
  passwordHash ??= auth.$context.then((context) => context.password.hash(PASSWORD))
  await db.insert(account).values({
    id: `${row.id}-credential`,
    accountId: row.id,
    providerId: 'credential',
    userId: row.id,
    password: await passwordHash,
    updatedAt: new Date(),
  })
  return { id: row.id, email: row.email, cookie: await signIn(row.email) }
}
