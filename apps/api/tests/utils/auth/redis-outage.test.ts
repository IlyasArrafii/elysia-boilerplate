import { afterAll, describe, expect, test } from 'bun:test'
import { createAuth, RATE_LIMIT_RULES } from '@repo/auth'
import { user } from '@repo/db'
import { inArray } from 'drizzle-orm'
import { env } from '../../../src/env'
import { ac, roles } from '../../../src/utils/auth/access'
import { auth } from '../../../src/utils/auth/auth'
import { DEFAULT_ROLE } from '../../../src/utils/auth/roles'
import { createSecondaryStorage } from '../../../src/utils/auth/storage'
import { createRedisStore } from '../../../src/utils/cache/store'
import { db } from '../../../src/utils/db'
import { createMemoryCounter } from '../../../src/utils/rate-limit/counter'
import { createRedis, type Redis } from '../../../src/utils/redis'
import { createStallingRedis, UNREACHABLE_REDIS_URL } from '../../helpers/redis'
import { PASSWORD, prepareTestDatabase, sessionCookie, uniqueEmail, WEB_ORIGIN } from './setup'

// A Redis outage must never fail `/api/auth/*` (DEC-055). Each test builds the app's Better Auth
// options on a Redis that is down, with a fresh fallback counter, so its rate-limit counts start at
// zero. No IP header is sent: in tests Better Auth takes every request as coming from 127.0.0.1.

const ready = await prepareTestDatabase()
const redisClients: Redis[] = []
const emails: string[] = []

afterAll(async () => {
  for (const redis of redisClients) redis.close()
  if (ready && emails.length > 0) await db.delete(user).where(inArray(user.email, emails))
})

function authOnRedis(url: string) {
  const redis = createRedis(url)
  redisClients.push(redis)
  const failures: unknown[] = []
  const storage = createSecondaryStorage(createRedisStore(redis.command, redis.transaction), {
    fallback: createMemoryCounter(),
    onFailure: (_, error) => failures.push(error),
  })
  const target = createAuth({
    db,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.WEB_URL],
    trustedProxies: [],
    secondaryStorage: storage,
    ac,
    roles,
    defaultRole: DEFAULT_ROLE,
    logger: auth.options.logger,
  })

  function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = { origin: WEB_ORIGIN }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.cookie !== undefined) headers.cookie = init.cookie
    return target.handler(
      new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    )
  }

  return { call, failures }
}

async function signUp(call: ReturnType<typeof authOnRedis>['call']): Promise<string> {
  const email = uniqueEmail()
  emails.push(email)
  const response = await call('/sign-up/email', { body: { email, password: PASSWORD, name: 'Outage User' } })
  expect(response.status).toBe(200)
  return email
}

const SIGN_IN_MAX = RATE_LIMIT_RULES['/sign-in/email'].max

describe.skipIf(!ready)('auth with Redis unreachable (needs the test PostgreSQL)', () => {
  test('sign-up, sign-in, get-session and sign-out succeed, and the session lives in PostgreSQL', async () => {
    const { call, failures } = authOnRedis(UNREACHABLE_REDIS_URL)

    const email = await signUp(call)
    const signIn = await call('/sign-in/email', { body: { email, password: PASSWORD } })
    expect(signIn.status).toBe(200)
    const cookie = sessionCookie(signIn)

    const session = await call('/get-session', { cookie })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ user: { email } })

    const signOut = await call('/sign-out', { method: 'POST', body: {}, cookie })
    expect(signOut.status).toBe(200)
    const afterSignOut = await call('/get-session', { cookie })
    expect(afterSignOut.status).toBe(200)
    expect(await afterSignOut.json()).toBeNull()

    // Redis was asked and failed: the requests above were counted by the fallback.
    expect(failures.length).toBeGreaterThanOrEqual(1)
  }, 20_000)

  test(`the sign-in limit still holds: attempt ${SIGN_IN_MAX + 1} within 60 s answers 429`, async () => {
    const { call, failures } = authOnRedis(UNREACHABLE_REDIS_URL)
    const email = await signUp(call)

    for (let attempt = 1; attempt <= SIGN_IN_MAX; attempt++) {
      expect((await call('/sign-in/email', { body: { email, password: PASSWORD } })).status).toBe(200)
    }
    const limited = await call('/sign-in/email', { body: { email, password: PASSWORD } })

    expect(limited.status).toBe(429)
    expect(limited.headers.get('x-retry-after')).toBe('60')
    expect(failures.length).toBeGreaterThanOrEqual(1)
  }, 20_000)

  // A Redis that accepts the connection and then never answers: the first request waits out one
  // deadline, and the open breaker spares the next ones.
  test('a Redis that stops answering costs the first request one deadline, then the open breaker skips it', async () => {
    const stalling = createStallingRedis()
    try {
      stalling.stall()
      const { call, failures } = authOnRedis(stalling.url)
      const email = await signUp(call)

      const started = performance.now()
      expect((await call('/sign-in/email', { body: { email, password: PASSWORD } })).status).toBe(200)

      expect(performance.now() - started).toBeLessThan(1000)
      expect(failures).toHaveLength(1)
    } finally {
      stalling.stop()
    }
  }, 20_000)
})
