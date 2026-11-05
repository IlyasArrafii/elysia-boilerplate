import { afterEach, describe, expect, test } from 'bun:test'
import { createAuth, RATE_LIMIT_RULES } from '@repo/auth'
import { env } from '../../../src/env'
import { ac, roles } from '../../../src/utils/auth/access'
import { auth } from '../../../src/utils/auth/auth'
import { DEFAULT_ROLE } from '../../../src/utils/auth/roles'
import { createSecondaryStorage } from '../../../src/utils/auth/storage'
import { createMemoryStore } from '../../../src/utils/cache/store'
import { db } from '../../../src/utils/db'
import { request } from '../../helpers/app'
import { uniqueIp, WEB_ORIGIN } from './setup'

// The Better Auth options of auth/README.md §2 that only show in how requests are answered. Every
// request here is refused or answered before any database read, so no PostgreSQL is needed.

// TEST-NET ranges, apart from the 10.x addresses `uniqueIp()` hands out to other tests.
const PROXY_RANGE = '203.0.113.0/24'
const PROXY = '203.0.113.7'

// The app's wiring with its own rate-limit store, so the counts start at zero and stay here.
function authWith(trustedProxies: string[]) {
  return createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.WEB_URL],
    trustedProxies,
    secondaryStorage: createSecondaryStorage(createMemoryStore()),
    ac,
    roles,
    defaultRole: DEFAULT_ROLE,
    logger: auth.options.logger,
  })
}

// An empty body fails validation (400) after the limiter has counted the request: no user is looked up.
function signInVia(target: ReturnType<typeof authWith>, forwardedFor: string): Promise<Response> {
  return target.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, 'x-forwarded-for': forwardedFor },
      body: '{}',
    }),
  )
}

const SIGN_IN_MAX = RATE_LIMIT_RULES['/sign-in/email'].max

async function useUpSignIns(target: ReturnType<typeof authWith>, forwardedFor: string): Promise<void> {
  for (let attempt = 0; attempt < SIGN_IN_MAX; attempt++) {
    expect((await signInVia(target, forwardedFor)).status).not.toBe(429)
  }
}

describe('trusted proxies', () => {
  test('the app passes TRUSTED_PROXIES to Better Auth', () => {
    expect(auth.options.advanced?.ipAddress?.trustedProxies).toEqual(env.TRUSTED_PROXIES)
  })

  test('behind a trusted proxy, each client in `x-forwarded-for: client, proxy` has its own bucket', async () => {
    const proxied = authWith([PROXY_RANGE])

    await useUpSignIns(proxied, `198.51.100.1, ${PROXY}`)

    expect((await signInVia(proxied, `198.51.100.1, ${PROXY}`)).status).toBe(429)
    expect((await signInVia(proxied, `198.51.100.2, ${PROXY}`)).status).toBe(400)
  })

  test('a hop that is not a trusted proxy is taken as the client, so a spoofed left entry changes nothing', async () => {
    const proxied = authWith([PROXY_RANGE])

    await useUpSignIns(proxied, `198.51.100.3, ${PROXY}`)

    expect((await signInVia(proxied, `198.51.100.99, 198.51.100.3, ${PROXY}`)).status).toBe(429)
  })

  // Why the option is needed: without it a multi-address header is no client IP at all, and every
  // such request lands in one shared bucket (127.0.0.1 in tests, `no-trusted-ip` in production).
  test('without trusted proxies, every client behind the proxy shares one bucket', async () => {
    const unproxied = authWith([])

    await useUpSignIns(unproxied, `198.51.100.4, ${PROXY}`)

    expect((await signInVia(unproxied, `198.51.100.5, ${PROXY}`)).status).toBe(429)
  })
})

describe('/get-session rate limit', () => {
  test('is turned off', () => {
    expect(RATE_LIMIT_RULES['/get-session']).toBe(false)
  })

  // Better Auth's default limit is 100 requests per 10 s. The web SSR sends no client IP, so in
  // production every visitor would count against one bucket.
  test('one client can read its session more than the default limit allows', async () => {
    const ip = uniqueIp()
    const statuses = new Set<number>()

    for (let call = 0; call < 120; call++) {
      const response = await request('/api/auth/get-session', { headers: { origin: WEB_ORIGIN, 'x-forwarded-for': ip } })
      statuses.add(response.status)
    }

    expect([...statuses]).toEqual([200])
  })
})

describe('CSRF and origin checks', () => {
  const previousTest = process.env.TEST
  afterEach(() => {
    if (previousTest === undefined) delete process.env.TEST
    else process.env.TEST = previousTest
  })

  // Better Auth 1.7.15 turns both off when `isTest()` is true unless the options say otherwise.
  test('stay on in test mode, with TEST=1 set', async () => {
    process.env.TEST = '1'
    const context = await authWith([]).$context

    expect(context.skipOriginCheck).toBe(false)
    expect(context.skipCSRFCheck).toBe(false)
  })

  test('a cross-origin cookie POST to sign-out is refused with TEST=1 set', async () => {
    process.env.TEST = '1'
    const target = authWith([])

    const response = await target.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-out`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
          cookie: 'app.session_token=any.value',
          'x-forwarded-for': uniqueIp(),
        },
        body: '{}',
      }),
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'INVALID_ORIGIN' })
  })

  test('the app refuses the same request (NODE_ENV=test makes isTest() true here)', async () => {
    const response = await request('/api/auth/sign-out', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.example',
        cookie: 'app.session_token=any.value',
        'x-forwarded-for': uniqueIp(),
      },
      body: '{}',
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'INVALID_ORIGIN' })
  })
})
