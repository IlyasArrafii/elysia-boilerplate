import { beforeAll, describe, expect, test } from 'bun:test'
import { clientIp } from '../../helpers/ip'
import { createClient } from '../helpers/client'
import { PASSWORD, send, signedInSuperAdmin, signIn, signUp, testIp, uniqueEmail, type Account } from '../helpers/users'

// Better Auth on the running stack (TESTING.md §3.2): the session lifecycle, the sign-in and sign-up
// rate limits (the API's Redis holds the counters), and impersonation that does not exist (DEC-032).

// `__Secure-app.session_token` when the API is served over HTTPS (packages/auth COOKIE_PREFIX).
const SESSION_COOKIE = /^(__Secure-)?app\.session_token=/

function sessionSetCookie(response: Response): string | undefined {
  return response.headers.getSetCookie().find((cookie) => SESSION_COOKIE.test(cookie))
}

async function getSession(cookie: string): Promise<unknown> {
  const response = await createClient().request('/api/auth/get-session', { headers: { cookie } })
  expect(response.status).toBe(200)
  return response.json()
}

describe('session lifecycle', () => {
  test('sign-up → sign-in → get-session → sign-out → the old session cookie gets 401', async () => {
    const account = await signUp('auth')

    const { client, response } = await signIn(account.email, PASSWORD)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ user: { id: account.id, email: account.email } })
    const setCookie = sessionSetCookie(response)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    const cookie = client.jar.header()
    if (cookie === undefined) throw new Error('sign-in set no cookie')

    expect(await getSession(cookie)).toMatchObject({
      user: { id: account.id, email: account.email, role: 'user' },
      session: { userId: account.id },
    })
    expect((await client.request('/api/me/permissions')).status).toBe(200)

    const signOut = await send(client, 'POST', '/api/auth/sign-out', {})
    expect(signOut.status).toBe(200)
    expect(await signOut.json()).toEqual({ success: true })

    // The cookie replayed after sign-out: the session is revoked on the server, not only cleared in the client.
    const after = await createClient().request('/api/me/permissions', { headers: { cookie } })
    expect(after.status).toBe(401)
    expect(await after.json()).toEqual({ code: 'UNAUTHORIZED', message: 'Sign in to continue' })
    expect(await getSession(cookie)).toBeNull()
    // Only that session ended: the one sign-up opened still works.
    expect((await account.client.request('/api/me/permissions')).status).toBe(200)
  })
})

describe('rate limits (auth/README.md, packages/auth RATE_LIMIT_RULES)', () => {
  test('the sixth sign-in from one IP within 60 s is 429, even with the right password; another IP is not affected', async () => {
    const account = await signUp('auth-limit')
    const ip = testIp()

    const statuses: number[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      statuses.push((await signIn(account.email, `wrong-password-${attempt}`, ip)).response.status)
    }
    const sixth = (await signIn(account.email, PASSWORD, ip)).response

    expect(statuses).toEqual([401, 401, 401, 401, 401])
    expect(sixth.status).toBe(429)
    expect(await sixth.json()).toEqual({ message: 'Too many requests. Please try again later.' })
    const retryAfter = Number(sixth.headers.get('x-retry-after'))
    expect(retryAfter).toBeGreaterThan(0)
    expect(retryAfter).toBeLessThanOrEqual(60)
    expect(sessionSetCookie(sixth)).toBeUndefined()

    expect((await signIn(account.email, PASSWORD, testIp())).response.status).toBe(200)
  })

  test('the fourth sign-up from one IP within 60 s is 429 and creates no account', async () => {
    const ip = testIp()
    const signUpFrom = (email: string) =>
      send(createClient(), 'POST', '/api/auth/sign-up/email', { email, password: PASSWORD, name: 'E2E limit' }, clientIp(ip))

    const statuses: number[] = []
    for (let attempt = 0; attempt < 3; attempt++) statuses.push((await signUpFrom(uniqueEmail('auth-signup-limit'))).status)
    const refusedEmail = uniqueEmail('auth-signup-limit')
    const fourth = await signUpFrom(refusedEmail)

    expect(statuses).toEqual([200, 200, 200])
    expect(fourth.status).toBe(429)
    expect(sessionSetCookie(fourth)).toBeUndefined()
    expect((await signIn(refusedEmail, PASSWORD)).response.status).toBe(401)
  })
})

describe('impersonation does not exist (DEC-032)', () => {
  let superAdmin: Account
  let target: Account

  beforeAll(async () => {
    superAdmin = await signedInSuperAdmin()
    target = await signUp('auth-impersonation')
  })

  test.each(['/api/auth/admin/impersonate-user', '/api/auth/admin/stop-impersonating'])(
    '%s is 404 for the seeded super_admin and for a guest, and swaps no session',
    async (path) => {
      const asSuperAdmin = await send(superAdmin.client, 'POST', path, { userId: target.id })
      expect(asSuperAdmin.status).toBe(404)
      expect(await asSuperAdmin.json()).toMatchObject({ code: 'NOT_FOUND' })
      expect(sessionSetCookie(asSuperAdmin)).toBeUndefined()

      const asGuest = await send(createClient(), 'POST', path, { userId: target.id })
      expect(asGuest.status).toBe(404)

      const cookie = superAdmin.client.jar.header()
      if (cookie === undefined) throw new Error('the super_admin client lost its cookie')
      const session = (await getSession(cookie)) as { user: { id: string }; session: { impersonatedBy?: string | null } }
      expect(session.user.id).toBe(superAdmin.id)
      expect(session.session.impersonatedBy ?? null).toBeNull()
    },
  )
})
