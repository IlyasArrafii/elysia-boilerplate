import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { account, user } from '@repo/db'
import { createAuth } from '@repo/auth'
import { eq } from 'drizzle-orm'
import { env } from '../../../src/env'
import { ac, roles } from '../../../src/utils/auth/access'
import { auth } from '../../../src/utils/auth/auth'
import { auditDatabaseHooks } from '../../../src/utils/auth/audit'
import { afterHook, beforeHook } from '../../../src/utils/auth/hooks'
import { DEFAULT_ROLE } from '../../../src/utils/auth/roles'
import { createSecondaryStorage } from '../../../src/utils/auth/storage'
import { createMemoryStore } from '../../../src/utils/cache/store'
import { db } from '../../../src/utils/db'
import { memory } from '../../helpers/app'
import { clientIp, prepareTestDatabase, testUsers, uniqueEmail, uniqueIp, WEB_ORIGIN } from './setup'

// Google sign-in with the provider mocked (TESTING.md §3.2): only Google's token endpoint is faked.
// Everything else (state cookie, PKCE, callback, account linking, hooks) is Better Auth's real code.
// The real Google round trip needs credentials and a browser and is checked by hand before release.

const ready = await prepareTestDatabase()
const { createUser, cleanup } = testUsers()

afterAll(cleanup)
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const CLIENT_ID = 'test-client-id'

// The app's own wiring, with Google configured (test env has no Google credentials).
const googleAuth = createAuth({
  db,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.WEB_URL],
  clientIpHeader: env.CLIENT_IP_HEADER,
  google: { clientId: CLIENT_ID, clientSecret: 'test-client-secret' },
  secondaryStorage: createSecondaryStorage(createMemoryStore()),
  ac,
  roles,
  defaultRole: DEFAULT_ROLE,
  hooks: { before: beforeHook, after: afterHook },
  databaseHooks: auditDatabaseHooks,
  // The app's logger settings: without them Better Auth prints to the console unscrubbed.
  logger: auth.options.logger,
})

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

// Better Auth decodes the ID token from the token endpoint response (it came over TLS from Google).
function idToken(email: string, emailVerified: boolean, sub: string): string {
  const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub, email, email_verified: emailVerified, name: 'Google User' }
  return `${base64Url({ alg: 'RS256', kid: 'test' })}.${base64Url(claims)}.signature`
}

let fetchSpy: ReturnType<typeof spyOn> | undefined

function mockGoogle(email: string, emailVerified = true): string {
  const sub = `google-${crypto.randomUUID()}`
  const realFetch = globalThis.fetch
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(TOKEN_ENDPOINT)) return realFetch(input, init)
    const tokens = { access_token: 'google-access-token', id_token: idToken(email, emailVerified, sub), expires_in: 3600, token_type: 'Bearer' }
    return Response.json(tokens)
  }
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(fakeFetch, { preconnect: realFetch.preconnect }))
  return sub
}

beforeEach(() => memory.clear())
afterEach(() => {
  fetchSpy?.mockRestore()
  fetchSpy = undefined
})

// Starts at `sign-in/social` and follows Google's redirect back to the callback with a code.
async function signInWithGoogle(): Promise<Response> {
  const ip = uniqueIp()
  const start = await googleAuth.handler(
    new Request('http://localhost/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...clientIp(ip) },
      body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
    }),
  )
  const { url } = (await start.json()) as { url: string }
  const state = new URL(url).searchParams.get('state') ?? ''
  const cookie = start.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  return googleAuth.handler(
    new Request(`http://localhost/api/auth/callback/google?code=google-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie, ...clientIp(ip) },
    }),
  )
}

async function sessionUserId(response: Response): Promise<string | undefined> {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('app.session_token='))
  if (cookie === undefined) return undefined
  const session = await googleAuth.api.getSession({ headers: new Headers({ cookie: cookie.split(';')[0] ?? '' }) })
  return session?.user.id
}

function providersOf(userId: string) {
  return db.select({ providerId: account.providerId, accessToken: account.accessToken }).from(account).where(eq(account.userId, userId))
}

describe.skipIf(!ready)('Google sign-in (token endpoint mocked; needs the test PostgreSQL)', () => {
  test('the authorization URL uses PKCE and state, and points back at the callback', async () => {
    const response = await googleAuth.handler(
      new Request('http://localhost/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...clientIp() },
        body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
      }),
    )
    const { url } = (await response.json()) as { url: string }
    const params = new URL(url).searchParams

    expect(response.status).toBe(200)
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('state')).toBeString()
    expect(params.get('redirect_uri')).toBe(`${env.BETTER_AUTH_URL}/api/auth/callback/google`)
    expect(response.headers.getSetCookie().some((value) => value.startsWith('app.oauth_state='))).toBe(true)
  })

  test('a new Google user is created with role user and the account is audited as linked', async () => {
    const email = uniqueEmail()
    mockGoogle(email)

    const callback = await signInWithGoogle()
    const userId = await sessionUserId(callback)

    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe('/')
    expect(userId).toBeString()
    const [row] = await db.select().from(user).where(eq(user.email, email))
    expect(row).toMatchObject({ id: userId, role: 'user', emailVerified: true })
    expect(memory.find('audit.account.linked')).toEqual([expect.objectContaining({ module: 'auth', userId, provider: 'google' })])
    expect(JSON.stringify(memory.lines)).not.toContain(email)
  })

  test('an existing account with a verified email is linked, not duplicated', async () => {
    const existing = await createUser()
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, existing.id))
    mockGoogle(existing.email)
    memory.clear()

    const callback = await signInWithGoogle()

    expect(callback.status).toBe(302)
    expect(await sessionUserId(callback)).toBe(existing.id)
    const providers = await providersOf(existing.id)
    expect(providers.map((row) => row.providerId).sort()).toEqual(['credential', 'google'])
    // encryptOAuthTokens: the stored token is not the one Google returned.
    expect(providers.find((row) => row.providerId === 'google')?.accessToken).not.toBe('google-access-token')
    expect(memory.find('audit.account.linked')).toEqual([expect.objectContaining({ userId: existing.id, provider: 'google' })])
  })

  // `requireLocalEmailVerified` (Better Auth 1.7.15 default): someone who pre-registers the victim's
  // address with a password cannot capture the victim's Google sign-in.
  test('an existing account with an unverified email is not linked and gets no session', async () => {
    const existing = await createUser()
    mockGoogle(existing.email)
    memory.clear()

    const callback = await signInWithGoogle()

    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toContain('error=')
    expect(await sessionUserId(callback)).toBeUndefined()
    expect((await providersOf(existing.id)).map((row) => row.providerId)).toEqual(['credential'])
    expect(memory.find('audit.account.linked')).toEqual([])
  })

  test('the callback without a valid state is refused', async () => {
    mockGoogle(uniqueEmail())

    const response = await googleAuth.handler(
      new Request('http://localhost/api/auth/callback/google?code=google-code&state=forged', { headers: clientIp() }),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('error=')
    expect(await sessionUserId(response)).toBeUndefined()
  })
})
