import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { Elysia, status, t } from 'elysia'
import { DefaultContext, rateLimit } from 'elysia-rate-limit'
import { createMemoryStore, type CacheStore } from '../../../src/utils/cache/store'
import { errorHandler, moduleError } from '../../../src/utils/error'
import { RATE_LIMITED, userRateLimit, type UserRateLimitOptions } from '../../../src/utils/rate-limit'
import { telemetry } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'

// `userRateLimit` on a small app whose `permission` macro stands in for the real one (utils/auth): it
// resolves `user` from the `x-user` header, 401 without it. The posts routes test it on the real app.
//
// Limiters are identified by their numbers process-wide (Pitfall 3 below), and `bun test` shares one
// module registry across the test files of a run, so every limiter in the run needs numbers of its
// own: these use max values no other test file uses with 60 s. 30 / 60 s is taken by `posts-write`
// as soon as a file imports the app; a test that claims it under another name makes that import throw
// in whichever file runs later.

const MINUTE = 60_000
let windowStart: number

beforeEach(() => {
  windowStart = (Math.floor(Date.now() / MINUTE) + 1) * MINUTE
  setSystemTime(new Date(windowStart + 15_000))
})
afterEach(() => setSystemTime())

const accessGuard = new Elysia({ name: 'test-access' }).macro({
  permission: (_permission: string) => ({
    resolve: ({ headers }: { headers: Record<string, string | undefined> }) => {
      const id = headers['x-user']
      if (id === undefined) throw status(401, { code: 'UNAUTHORIZED', message: 'Sign in to continue' })
      return { user: { id } }
    },
  }),
})

// The limiter inside the guard that declares the permission, as a module mounts it.
function guardedApp(limiter: ReturnType<typeof userRateLimit>) {
  return new Elysia({ prefix: '/items' })
    .use(accessGuard)
    .get('/', () => 'list', { permission: 'items:read' })
    .guard({ permission: 'items:write' }, (writes) =>
      writes
        .use(limiter)
        .post('/', () => 'created', { body: t.Object({ title: t.String() }) })
        .delete('/:id', () => {
          throw moduleError('items', 404, 'ITEM_NOT_FOUND', 'Item not found')
        }),
    )
}

function send(app: { handle(request: Request): Promise<Response> }, method: string, path: string, user?: string, body?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (user !== undefined) headers['x-user'] = user
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body }))
}

const VALID = JSON.stringify({ title: 'A title' })

// A 60 s limiter on a fresh memory store. Pick a `max` no other limiter in the run has with 60 s, and
// never 30 (`posts-write`); see the note at the top.
function limiter(options: Partial<UserRateLimitOptions> & Pick<UserRateLimitOptions, 'name' | 'max'>) {
  return userRateLimit({ windowSeconds: 60, store: createMemoryStore(), ...options })
}

describe('userRateLimit', () => {
  test('the request after max is 429 RATE_LIMITED with Retry-After and the RateLimit headers', async () => {
    const app = guardedApp(limiter({ name: 'test-items-3', max: 3 }))

    for (let index = 0; index < 3; index++) expect((await send(app, 'POST', '/items/', 'user-a', VALID)).status).toBe(200)
    const limited = await send(app, 'POST', '/items/', 'user-a', VALID)

    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual(RATE_LIMITED)
    expect(limited.headers.get('content-type')).toContain('application/json')
    expect(Object.fromEntries(['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'retry-after'].map((name) => [name, limited.headers.get(name)]))).toEqual({
      'ratelimit-limit': '3',
      'ratelimit-remaining': '0',
      'ratelimit-reset': '45',
      'retry-after': '45',
    })
  })

  test('counts each user on their own, and leaves routes outside the guard alone', async () => {
    const app = guardedApp(limiter({ name: 'test-items-3', max: 3 }))
    for (let index = 0; index < 4; index++) await send(app, 'POST', '/items/', 'user-a', VALID)

    const byOther = await send(app, 'POST', '/items/', 'user-b', VALID)
    expect(byOther.status).toBe(200)
    expect(byOther.headers.get('ratelimit-remaining')).toBe('2')

    for (let index = 0; index < 5; index++) {
      const read = await send(app, 'GET', '/items/', 'user-a')
      expect(read.status).toBe(200)
      expect(read.headers.get('ratelimit-limit')).toBeNull()
    }
  })

  test('a 401 from the guard is not counted', async () => {
    const store = createMemoryStore()
    const app = guardedApp(limiter({ name: 'test-items-3', max: 3, store }))

    for (let index = 0; index < 5; index++) expect((await send(app, 'POST', '/items/', undefined, VALID)).status).toBe(401)

    expect(await store.delPattern('ratelimit:*')).toBe(0)
  })

  // The plugin's `onError` hook counts parse errors, validation errors and 404s, and calls the
  // generator before any macro resolved the user. Here no other error hook answers first, so the hook
  // runs: the generator's `unresolved` key keeps it from throwing (which would be a 500) and `skip`
  // keeps it from counting. The real app's error handler answers first (posts rate-limit tests).
  test('without an error handler in front, a body that fails to validate or parse is never a 500 and never counted', async () => {
    const store = createMemoryStore()
    const app = guardedApp(limiter({ name: 'test-items-3', max: 3, store }))

    for (let index = 0; index < 5; index++) {
      expect((await send(app, 'POST', '/items/', 'user-a', JSON.stringify({ nope: 1 }))).status).toBe(422)
      expect((await send(app, 'POST', '/items/', 'user-a', '{"title": "unterminated')).status).toBe(400)
    }

    expect(await store.delPattern('ratelimit:*')).toBe(0)
    expect((await send(app, 'POST', '/items/', 'user-a', VALID)).headers.get('ratelimit-remaining')).toBe('2')
  })

  // Pitfall 2: the plugin counts in `beforeHandle`, and again in its `onError` hook for a 404. On a
  // guarded route Elysia 1.4.30 runs that hook twice, so on its own the plugin counts a 404 three times.
  test('without an error handler in front, a 404 from the handler counts three times', async () => {
    const store = createMemoryStore()
    const app = guardedApp(limiter({ name: 'test-items-3', max: 3, store }))

    expect((await send(app, 'DELETE', '/items/missing', 'user-a')).status).toBe(404)

    expect(await store.get(`ratelimit:test-items-3:user-a:${Math.floor(Date.now() / MINUTE)}`)).toBe('3')
    expect((await send(app, 'POST', '/items/', 'user-a', VALID)).status).toBe(429)
  })

  // The app's error handler is global and mounted before every module, so it answers every error
  // before the plugin's hook can run: a 404 counts once, like any other answer.
  test('behind the app error handler, a 404 from the handler counts once', async () => {
    const store = createMemoryStore()
    const app = new Elysia().use(errorHandler).use(guardedApp(limiter({ name: 'test-items-3', max: 3, store })))

    const response = await send(app, 'DELETE', '/items/missing', 'user-a')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ code: 'ITEM_NOT_FOUND', message: 'Item not found' })
    expect(await store.get(`ratelimit:test-items-3:user-a:${Math.floor(Date.now() / MINUTE)}`)).toBe('1')
  })

  test('mounted where no user is resolved, it counts nothing rather than one bucket for everyone', async () => {
    const store = createMemoryStore()
    const app = new Elysia().use(limiter({ name: 'test-items-3', max: 3, store })).post('/open', () => 'ok')

    for (let index = 0; index < 5; index++) expect((await send(app, 'POST', '/open', 'user-a')).status).toBe(200)

    expect(await store.delPattern('ratelimit:*')).toBe(0)
  })

  test('with the store failing, limits still apply from memory, with one cache.unavailable and no 500', async () => {
    const memory = createMemorySink()
    const detach = telemetry.addSink(memory)
    try {
      let calls = 0
      const failing: CacheStore = {
        ...createMemoryStore(),
        increment: () => {
          calls++
          return Promise.reject(new Error('Connection closed'))
        },
      }
      const app = guardedApp(userRateLimit({ name: 'test-items-outage', max: 4, windowSeconds: 60, store: failing }))

      const statuses = []
      for (let index = 0; index < 6; index++) statuses.push((await send(app, 'POST', '/items/', 'user-a', VALID)).status)

      expect(statuses).toEqual([200, 200, 200, 200, 429, 429])
      expect(calls).toBe(1)
      expect(memory.find('cache.unavailable').map(({ source, operation }) => ({ source, operation }))).toEqual([
        { source: 'ratelimit:test-items-outage', operation: 'increment' },
      ])
    } finally {
      detach()
    }
  })

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses max %p', (max) => {
    expect(() => limiter({ name: 'test-items-bad', max })).toThrow(RangeError)
  })

  test.each([0, 0.5, 1.5, Number.NaN])('refuses a %p s window', (windowSeconds) => {
    expect(() => limiter({ name: 'test-items-bad', max: 5, windowSeconds })).toThrow(RangeError)
  })

  test('refuses a name that is not a lower-case slug', () => {
    expect(() => limiter({ name: 'Items', max: 5 })).toThrow('Rate-limit name must match')
  })
})

// elysia-rate-limit 4.6.3 names its plugin `elysia-rate-limit` with the seed `<max>:<duration>:<scoping>`,
// and Elysia keeps one plugin per name and seed in an instance.
describe('limiters with the same numbers (Pitfall 3)', () => {
  function rawLimiter(label: string, fired: string[]) {
    return rateLimit({
      scoping: 'scoped',
      max: 5,
      duration: MINUTE,
      context: new DefaultContext(),
      generator: () => {
        fired.push(label)
        return 'key'
      },
    })
  }

  test('Elysia drops the second of two plugin limiters with the same numbers in one instance', async () => {
    const fired: string[] = []
    const app = new Elysia().use(rawLimiter('first', fired)).use(rawLimiter('second', fired)).post('/', () => 'ok')

    await app.handle(new Request('http://localhost/', { method: 'POST' }))

    expect(fired).toEqual(['first'])
  })

  test('and drops a guard limiter with the numbers of a limiter the module already has', async () => {
    const fired: string[] = []
    const app = new Elysia().use(rawLimiter('module', fired)).guard({}, (guarded) => guarded.use(rawLimiter('guard', fired)).post('/', () => 'ok'))

    await app.handle(new Request('http://localhost/', { method: 'POST' }))

    expect(fired).toEqual(['module'])
  })

  test('so userRateLimit refuses a second name with the same max and window', () => {
    userRateLimit({ name: 'test-pitfall-first', max: 7, windowSeconds: 60, store: createMemoryStore() })

    expect(() => userRateLimit({ name: 'test-pitfall-second', max: 7, windowSeconds: 60, store: createMemoryStore() })).toThrow(
      'has the same max and window (7/60s) as "test-pitfall-first"',
    )
  })

  test('refuses other numbers for a name that has some, since the name decides the Redis keys', () => {
    userRateLimit({ name: 'test-pitfall-name', max: 8, windowSeconds: 60, store: createMemoryStore() })

    expect(() => userRateLimit({ name: 'test-pitfall-name', max: 9, windowSeconds: 60, store: createMemoryStore() })).toThrow(
      'already exists with 8/60s',
    )
  })

  // The dedupe runs from a module down into its guards, not between sibling guards: one limiter used
  // in two guards of a module limits both, with one count per user, and reaches nothing else.
  test('one limiter in two guards of a module limits both with one count, and nothing else', async () => {
    const store = createMemoryStore()
    const writeLimit = userRateLimit({ name: 'test-pitfall-shared', max: 15, windowSeconds: 60, store })
    const module = new Elysia({ prefix: '/m' })
      .use(accessGuard)
      .guard({ permission: 'a:write' }, (guarded) => guarded.use(writeLimit).post('/a', () => 'a'))
      .guard({ permission: 'b:write' }, (guarded) => guarded.use(writeLimit).post('/b', () => 'b'))
      .guard({ permission: 'c:write' }, (guarded) => guarded.post('/c', () => 'c'))
      .post('/d', () => 'd', { permission: 'd:write' })
    const app = new Elysia().use(errorHandler).use(module)

    const remaining = []
    for (const path of ['/m/a', '/m/b', '/m/a', '/m/b']) remaining.push((await send(app, 'POST', path, 'user-a')).headers.get('ratelimit-remaining'))

    expect(remaining).toEqual(['14', '13', '12', '11'])
    expect(await store.get(`ratelimit:test-pitfall-shared:user-a:${Math.floor(Date.now() / MINUTE)}`)).toBe('4')
    expect((await send(app, 'POST', '/m/c', 'user-a')).headers.get('ratelimit-limit')).toBeNull()
    expect((await send(app, 'POST', '/m/d', 'user-a')).headers.get('ratelimit-limit')).toBeNull()
  })

  test('building the same limiter again is allowed', () => {
    userRateLimit({ name: 'test-pitfall-again', max: 10, windowSeconds: 60, store: createMemoryStore() })

    expect(() => userRateLimit({ name: 'test-pitfall-again', max: 10, windowSeconds: 60, store: createMemoryStore() })).not.toThrow()
  })

  test('a limiter that failed its checks claims neither its numbers nor its name', () => {
    expect(() => userRateLimit({ name: 'Bad Name', max: 11, windowSeconds: 60, store: createMemoryStore() })).toThrow('Rate-limit name must match')
    expect(() => userRateLimit({ name: 'test-pitfall-failed', max: 12, windowSeconds: 1.5, store: createMemoryStore() })).toThrow(RangeError)

    expect(() => userRateLimit({ name: 'test-pitfall-numbers', max: 11, windowSeconds: 60, store: createMemoryStore() })).not.toThrow()
    expect(() => userRateLimit({ name: 'test-pitfall-failed', max: 12, windowSeconds: 60, store: createMemoryStore() })).not.toThrow()
  })

  test('limiters with other numbers in two modules both count', async () => {
    const first = guardedApp(userRateLimit({ name: 'test-pitfall-a', max: 13, windowSeconds: 60, store: createMemoryStore() }))
    const second = new Elysia({ prefix: '/other' })
      .use(accessGuard)
      .guard({ permission: 'other:write' }, (writes) =>
        writes.use(userRateLimit({ name: 'test-pitfall-b', max: 14, windowSeconds: 60, store: createMemoryStore() })).post('/', () => 'ok'),
      )
    const app = new Elysia().use(first).use(second)

    expect((await send(app, 'POST', '/items/', 'user-a', VALID)).headers.get('ratelimit-limit')).toBe('13')
    expect((await send(app, 'POST', '/other/', 'user-a')).headers.get('ratelimit-limit')).toBe('14')
  })
})
