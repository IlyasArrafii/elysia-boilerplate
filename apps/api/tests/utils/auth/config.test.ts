import { afterEach, describe, expect, test } from 'bun:test'
import { createAuth, RATE_LIMIT_RULES, type SecondaryStorage } from '@repo/auth'
import { env } from '../../../src/env'
import { ac, roles } from '../../../src/utils/auth/access'
import { auth } from '../../../src/utils/auth/auth'
import { DEFAULT_ROLE } from '../../../src/utils/auth/roles'
import { createSecondaryStorage } from '../../../src/utils/auth/storage'
import { createMemoryStore } from '../../../src/utils/cache/store'
import { db } from '../../../src/utils/db'
import { request } from '../../helpers/app'
import { PRODUCTION_ENV, runInApiProcess, UNREACHABLE_REDIS_URL } from '../../helpers/redis'
import { clientIp, WEB_ORIGIN } from './setup'

// The Better Auth options of auth/README.md §2 that only show in how requests are answered. Every
// request here is refused or answered before any database read, so no PostgreSQL is needed.

// TEST-NET addresses, apart from the 10.x addresses `uniqueIp()` hands out to other tests. Each instance
// below has its own rate-limit store, so fixed addresses never meet another test's counts.
const CLIENT = '203.0.113.7'
const OTHER_CLIENT = '203.0.113.8'
const SIGN_IN_BUCKET = '|/sign-in/email'
const SIGN_IN_MAX = RATE_LIMIT_RULES['/sign-in/email'].max
const PROCESS_TIMEOUT_MS = 20_000

// Rate-limit storage that also lists the bucket key of every request it counts.
function countingStorage(keys: string[]): SecondaryStorage {
  const storage = createSecondaryStorage(createMemoryStore())
  const { increment } = storage
  if (increment === undefined) throw new Error('createSecondaryStorage must implement increment: the rate limiter needs it')
  return {
    ...storage,
    increment: (key, ttl) => {
      keys.push(key)
      return increment(key, ttl)
    },
  }
}

// The app's wiring with its own rate-limit store, so the counts start at zero and stay here.
function authWith(keys: string[] = []) {
  return createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.WEB_URL],
    clientIpHeader: env.CLIENT_IP_HEADER,
    secondaryStorage: countingStorage(keys),
    ac,
    roles,
    defaultRole: DEFAULT_ROLE,
    logger: auth.options.logger,
  })
}

// An empty body fails validation (400) after the limiter has counted the request: no user is looked up.
async function signInVia(target: ReturnType<typeof authWith>, headers: Record<string, string>): Promise<number> {
  const response = await target.handler(
    new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...headers },
      body: '{}',
    }),
  )
  return response.status
}

const allowedThenLimited = [...Array<number>(SIGN_IN_MAX).fill(400), 429]

describe('client IP (CLIENT_IP_HEADER)', () => {
  test('the app reads the client IP from CLIENT_IP_HEADER alone, with no trusted proxies', () => {
    expect(auth.options.advanced?.ipAddress).toEqual({ ipAddressHeaders: [env.CLIENT_IP_HEADER], ipv6Subnet: 64 })
  })

  test('the sixth sign-in from one client IP within 60 s is 429, and another client IP is not limited', async () => {
    const keys: string[] = []
    const target = authWith(keys)

    const statuses: number[] = []
    for (let attempt = 0; attempt <= SIGN_IN_MAX; attempt++) statuses.push(await signInVia(target, clientIp(CLIENT)))

    expect(statuses).toEqual(allowedThenLimited)
    expect(await signInVia(target, clientIp(OTHER_CLIENT))).toBe(400)
    expect([...new Set(keys)]).toEqual([CLIENT + SIGN_IN_BUCKET, OTHER_CLIENT + SIGN_IN_BUCKET])
  })

  // Cloudflare appends to a client-sent `x-forwarded-for`, so the client controls its left part. Only the
  // header the edge overwrites counts: changing `x-forwarded-for` on every request gets no fresh bucket.
  test('a different x-forwarded-for on every request does not reset the count', async () => {
    const keys: string[] = []
    const target = authWith(keys)

    const statuses: number[] = []
    for (let attempt = 0; attempt <= SIGN_IN_MAX; attempt++) {
      statuses.push(await signInVia(target, { ...clientIp(CLIENT), 'x-forwarded-for': `198.51.100.${attempt + 1}` }))
    }

    expect(statuses).toEqual(allowedThenLimited)
    expect([...new Set(keys)]).toEqual([CLIENT + SIGN_IN_BUCKET])
  })

  // Better Auth believes the header only when it holds exactly one IP. Anything else is no client IP, and
  // in production every such request shares one bucket per path, `no-trusted-ip` (development and test use
  // 127.0.0.1 instead, which is why this runs in a production child process). One client sending a list
  // can therefore use up that bucket for everyone else who has no usable IP, never for a real single-IP
  // client. Cloudflare always sends exactly one IP, so behind it this bucket only sees direct requests.
  test(
    'a header with two IPs, or only x-forwarded-for, lands in the shared no-trusted-ip bucket in production',
    async () => {
      const requests = [
        ...Array.from({ length: SIGN_IN_MAX }, () => clientIp('1.1.1.1, 2.2.2.2')),
        clientIp('3.3.3.3, 4.4.4.4'),
        { 'x-forwarded-for': '198.51.100.60' },
        clientIp('203.0.113.20'),
      ]
      const script = `
        const { createAuth } = await import("@repo/auth")
        const { createDb } = await import("@repo/db")
        const { ac, roles } = await import("./src/utils/auth/access.ts")
        const { DEFAULT_ROLE } = await import("./src/utils/auth/roles.ts")
        const { createSecondaryStorage } = await import("./src/utils/auth/storage.ts")
        const { createMemoryStore } = await import("./src/utils/cache/store.ts")
        const origin = "https://app.example.test"
        const keys = []
        const storage = createSecondaryStorage(createMemoryStore())
        const target = createAuth({
          db: createDb(process.env.DATABASE_URL),
          secret: process.env.BETTER_AUTH_SECRET,
          baseURL: origin,
          trustedOrigins: [origin],
          clientIpHeader: ${JSON.stringify(env.CLIENT_IP_HEADER)},
          secondaryStorage: { ...storage, increment: (key, ttl) => (keys.push(key), storage.increment(key, ttl)) },
          ac,
          roles,
          defaultRole: DEFAULT_ROLE,
          logger: { disabled: true },
        })
        const statuses = []
        for (const headers of ${JSON.stringify(requests)}) {
          const response = await target.handler(new Request(origin + "/api/auth/sign-in/email", {
            method: "POST",
            headers: { "content-type": "application/json", origin, ...headers },
            body: "{}",
          }))
          statuses.push(response.status)
        }
        console.log(JSON.stringify({ statuses, keys }))
        process.exit(0)
      `
      // `storage.ts` reaches `env.ts` (through `utils/cache/report`), so the child needs everything
      // production requires. Nothing here dials Redis or MongoDB.
      const result = await runInApiProcess(
        script,
        { ...PRODUCTION_ENV, LOG_LEVEL: 'silent', REDIS_URL: UNREACHABLE_REDIS_URL },
        { timeoutMs: PROCESS_TIMEOUT_MS },
      )

      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      const { statuses, keys } = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as { statuses: number[]; keys: string[] }
      // Five lists use up the bucket; another list and a bare x-forwarded-for are refused from the same one.
      expect(statuses).toEqual([...allowedThenLimited, 429, 400])
      expect(keys).toEqual([...Array<string>(SIGN_IN_MAX + 2).fill('no-trusted-ip' + SIGN_IN_BUCKET), '203.0.113.20' + SIGN_IN_BUCKET])
    },
    PROCESS_TIMEOUT_MS + 5000,
  )
})

describe('/get-session rate limit', () => {
  test('is turned off', () => {
    expect(RATE_LIMIT_RULES['/get-session']).toBe(false)
  })

  // Better Auth's default limit is 100 requests per 10 s. The web SSR sends no client IP, so in
  // production every visitor would count against one bucket.
  test('one client can read its session more than the default limit allows', async () => {
    const headers = { origin: WEB_ORIGIN, ...clientIp() }
    const statuses = new Set<number>()

    for (let call = 0; call < 120; call++) {
      const response = await request('/api/auth/get-session', { headers })
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
    const context = await authWith().$context

    expect(context.skipOriginCheck).toBe(false)
    expect(context.skipCSRFCheck).toBe(false)
  })

  test('a cross-origin cookie POST to sign-out is refused with TEST=1 set', async () => {
    process.env.TEST = '1'
    const target = authWith()

    const response = await target.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth/sign-out`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
          cookie: 'app.session_token=any.value',
          ...clientIp(),
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
        ...clientIp(),
      },
      body: '{}',
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'INVALID_ORIGIN' })
  })
})
