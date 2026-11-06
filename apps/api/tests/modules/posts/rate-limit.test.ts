import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { post } from '@repo/db'
import { eq } from 'drizzle-orm'
import { env } from '../../../src/env'
import { cacheStore } from '../../../src/utils/cache'
import { RATE_LIMITED } from '../../../src/utils/rate-limit'
import { memory, request } from '../../helpers/app'
import { createUser, type SignedInUser } from '../../helpers/auth'
import { fixtures, testDb } from '../../helpers/db'

// The per-user write limit on POST, PATCH and DELETE /api/posts: 30 per user per clock-aligned minute
// (ARCHITECTURE.md §10). The tests run on the whole app, so they also prove the
// limiter is mounted where it counts: a limiter mounted in the wrong place fails silently.
//
// The counters live in the test memory store (tests/setup.ts). The clock is frozen 15 s into a
// window, so a run never straddles two windows, and the counters are cleared before each test.

const db = await testDb()
const scope = fixtures(db)
const MAX = 30
const WINDOW_MS = 60_000
const MISSING_ID = '00000000-0000-4000-8000-000000000000'

let writer: SignedInUser
let bystander: SignedInUser
// A role the registry does not know: signed in, but no posts permission at all.
let outsider: SignedInUser
// The start of the window the clock is frozen in: the next one after the real clock, so sessions
// created now are still valid.
let windowStart: number

beforeAll(async () => {
  writer = await createUser(scope, db, 'user')
  bystander = await createUser(scope, db, 'user')
  outsider = await createUser(scope, db, 'retired_role')
})
beforeEach(async () => {
  windowStart = (Math.floor(Date.now() / WINDOW_MS) + 1) * WINDOW_MS
  setSystemTime(new Date(windowStart + 15_000))
  await cacheStore.delPattern('ratelimit:posts-write:*')
  memory.clear()
})
afterEach(() => setSystemTime())
afterAll(() => scope.cleanup())

interface CallOptions {
  cookie?: string
  body?: unknown
  raw?: string
}

function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { origin: env.WEB_URL }
  if (options.cookie !== undefined) headers.cookie = options.cookie
  let body: string | undefined
  if (options.raw !== undefined || options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = options.raw ?? JSON.stringify(options.body)
  }
  return request(path, { method, headers, body })
}

let titleCount = 0
function newPost(): { title: string; content: string } {
  titleCount++
  return { title: `Limited post ${scope.run.slice(0, 8)} ${titleCount}`, content: 'Content long enough.' }
}

// What the limiter stored for the user in the window the clock is in, as the store holds it.
function storedCount(user: SignedInUser, at = Date.now()): Promise<string | null> {
  return cacheStore.get(`ratelimit:posts-write:${user.id}:${Math.floor(at / WINDOW_MS)}`)
}

function rateLimitHeaders(response: Response) {
  return {
    limit: response.headers.get('ratelimit-limit'),
    remaining: response.headers.get('ratelimit-remaining'),
    reset: response.headers.get('ratelimit-reset'),
    retryAfter: response.headers.get('retry-after'),
  }
}

// One created post, then edits of it up to `count` writes in all.
async function spendWrites(user: SignedInUser, count: number): Promise<string> {
  const created = await call('POST', '/api/posts', { cookie: user.cookie, body: newPost() })
  expect(created.status).toBe(201)
  const { id } = (await created.json()) as { id: string }
  for (let index = 1; index < count; index++) {
    const edited = await call('PATCH', `/api/posts/${id}`, { cookie: user.cookie, body: { content: `Edit number ${index}.` } })
    expect(edited.status).toBe(200)
  }
  return id
}

describe('per-user write limit', () => {
  test('the 31st write in a window is 429 RATE_LIMITED with Retry-After, and changes nothing', async () => {
    await spendWrites(writer, MAX)
    const attempt = newPost()

    const limited = await call('POST', '/api/posts', { cookie: writer.cookie, body: attempt })

    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual(RATE_LIMITED)
    expect(rateLimitHeaders(limited)).toEqual({ limit: '30', remaining: '0', reset: '45', retryAfter: '45' })
    expect(await db.select({ id: post.id }).from(post).where(eq(post.title, attempt.title))).toEqual([])
    // Returned by the limiter, not thrown: logged as a request like any other, never as an error.
    expect(limited.headers.get('x-request-id')).toBeString()
    expect(memory.find('http.request').filter((event) => event.status === 429)).toEqual([
      expect.objectContaining({ method: 'POST', route: '/api/posts', status: 429, module: 'posts', userId: writer.id }),
    ])
    expect(memory.find('http.error')).toEqual([])
  })

  test('PATCH and DELETE share the limit with POST', async () => {
    const id = await spendWrites(writer, MAX)

    expect((await call('PATCH', `/api/posts/${id}`, { cookie: writer.cookie, body: { content: 'One too many.' } })).status).toBe(429)
    expect((await call('DELETE', `/api/posts/${id}`, { cookie: writer.cookie })).status).toBe(429)
    expect(await db.select({ content: post.content }).from(post).where(eq(post.id, id))).toEqual([{ content: `Edit number ${MAX - 1}.` }])
  })

  test('another user and every GET are unaffected', async () => {
    const id = await spendWrites(writer, MAX)
    expect((await call('POST', '/api/posts', { cookie: writer.cookie, body: newPost() })).status).toBe(429)

    const byBystander = await call('POST', '/api/posts', { cookie: bystander.cookie, body: newPost() })
    expect(byBystander.status).toBe(201)
    expect(rateLimitHeaders(byBystander)).toEqual({ limit: '30', remaining: '29', reset: '45', retryAfter: null })

    for (const path of ['/api/posts', `/api/posts/${id}`]) {
      const read = await call('GET', path, { cookie: writer.cookie })
      expect(read.status).toBe(200)
      expect(rateLimitHeaders(read)).toEqual({ limit: null, remaining: null, reset: null, retryAfter: null })
    }
  })

  test('the window is aligned to the clock: the key holds its number, and RateLimit-Reset is its end', async () => {
    const window = windowStart / WINDOW_MS

    const first = await call('POST', '/api/posts', { cookie: writer.cookie, body: newPost() })
    expect(rateLimitHeaders(first)).toMatchObject({ remaining: '29', reset: '45' })
    expect(await cacheStore.get(`ratelimit:posts-write:${writer.id}:${window}`)).toBe('1')

    setSystemTime(new Date(windowStart + WINDOW_MS - 500))
    const last = await call('POST', '/api/posts', { cookie: writer.cookie, body: newPost() })
    expect(rateLimitHeaders(last)).toMatchObject({ remaining: '28', reset: '1' })

    // The next window counts from zero under its own key, whatever the user did in the last one.
    setSystemTime(new Date(windowStart + WINDOW_MS))
    const next = await call('POST', '/api/posts', { cookie: writer.cookie, body: newPost() })
    expect(rateLimitHeaders(next)).toMatchObject({ remaining: '29', reset: '60' })
    expect(await cacheStore.get(`ratelimit:posts-write:${writer.id}:${window + 1}`)).toBe('1')
    expect(await cacheStore.get(`ratelimit:posts-write:${writer.id}:${window}`)).toBe('2')
  })

  test('a user who used up the limit writes again in the next window', async () => {
    await spendWrites(writer, MAX)
    expect((await call('POST', '/api/posts', { cookie: writer.cookie, body: newPost() })).status).toBe(429)

    setSystemTime(new Date(windowStart + WINDOW_MS))

    expect((await call('POST', '/api/posts', { cookie: writer.cookie, body: newPost() })).status).toBe(201)
  })
})

describe('what the limit does not count', () => {
  test('401 without a session and 403 without posts:write are not counted', async () => {
    for (let index = 0; index <= MAX; index++) {
      const anonymous = await call('POST', '/api/posts', { body: newPost() })
      expect(anonymous.status).toBe(401)
      expect(rateLimitHeaders(anonymous).remaining).toBeNull()
      const forbidden = await call('DELETE', `/api/posts/${MISSING_ID}`, { cookie: outsider.cookie })
      expect(forbidden.status).toBe(403)
      expect(rateLimitHeaders(forbidden).remaining).toBeNull()
    }

    expect(await storedCount(outsider)).toBeNull()
    // Nothing at all was counted, under any key.
    expect(await cacheStore.delPattern('ratelimit:posts-write:*')).toBe(0)
  })

  test('a body that fails to validate or parse is 400, never 500 or 429, and is not counted', async () => {
    for (let index = 0; index <= MAX; index++) {
      expect((await call('POST', '/api/posts', { cookie: writer.cookie, body: { title: 'ab' } })).status).toBe(400)
      expect((await call('POST', '/api/posts', { cookie: writer.cookie, raw: '{"title": "unterminated' })).status).toBe(400)
      expect((await call('PATCH', '/api/posts/not-a-uuid', { cookie: writer.cookie, body: { title: 'Valid title' } })).status).toBe(400)
    }
    expect(await storedCount(writer)).toBeNull()

    const valid = await call('POST', '/api/posts', { cookie: writer.cookie, body: newPost() })
    expect(valid.status).toBe(201)
    expect(rateLimitHeaders(valid).remaining).toBe('29')
  })

  // Only the `permission` 403 comes before the limiter. The ownership check runs in the service, so
  // its 403 is answered by the handler and counted like any other answer.
  test('the ownership 403 from the service is counted', async () => {
    const created = await call('POST', '/api/posts', { cookie: writer.cookie, body: newPost() })
    const { id } = (await created.json()) as { id: string }

    const notTheirs = await call('PATCH', `/api/posts/${id}`, { cookie: bystander.cookie, body: { title: 'Not my post' } })

    expect(notTheirs.status).toBe(403)
    expect(rateLimitHeaders(notTheirs).remaining).toBe('29')
    expect(await storedCount(bystander)).toBe('1')
  })
})

// The plugin counts a request in `beforeHandle`, and again in its `onError` hook when the error is a
// 404. In this app the global error handler answers every error first, so that hook never runs and a
// 404 from the handler is counted once, like any other answer.
describe('a 404 from the handler', () => {
  test('is counted once', async () => {
    const first = await call('PATCH', `/api/posts/${MISSING_ID}`, { cookie: writer.cookie, body: { title: 'Valid title' } })
    expect(first.status).toBe(404)
    expect(await storedCount(writer)).toBe('1')

    expect((await call('DELETE', `/api/posts/${MISSING_ID}`, { cookie: writer.cookie })).status).toBe(404)
    expect(await storedCount(writer)).toBe('2')
  })

  test('uses up the limit like any other write', async () => {
    for (let index = 0; index < MAX; index++) {
      expect((await call('DELETE', `/api/posts/${MISSING_ID}`, { cookie: writer.cookie })).status).toBe(404)
    }

    expect((await call('DELETE', `/api/posts/${MISSING_ID}`, { cookie: writer.cookie })).status).toBe(429)
  })
})
