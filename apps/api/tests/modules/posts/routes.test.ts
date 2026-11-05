import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { post } from '@repo/db'
import { eq } from 'drizzle-orm'
import { env, readPostsLimits } from '../../../src/env'
import { PostService } from '../../../src/modules/posts/service'
import { cacheStore } from '../../../src/utils/cache'
import { memory, request } from '../../helpers/app'
import { createUser, type SignedInUser } from '../../helpers/auth'
import { fixtures, testDb } from '../../helpers/db'
import { uniqueIp } from '../../helpers/ip'
import { runInApiProcess } from '../../helpers/redis'

// TESTING.md §3.1 for the posts module (API.md §3.4, F-04). The test database is shared, so no test
// assumes it holds only its own posts: lists are checked for shape and for the posts made here.

const db = await testDb()
const scope = fixtures(db)
const { titleMaxLength, contentMaxLength } = readPostsLimits()
const MISSING_ID = '00000000-0000-4000-8000-000000000000'
const FORBIDDEN_BODY = { code: 'FORBIDDEN', message: 'You do not have permission to do this' }
const NOT_FOUND_BODY = { code: 'POST_NOT_FOUND', message: 'Post not found' }

let author: SignedInUser
let other: SignedInUser
let admin: SignedInUser
let superAdmin: SignedInUser
// A role the registry does not know: signed in, but no posts permission at all.
let outsider: SignedInUser
let titleCount = 0

beforeAll(async () => {
  author = await createUser(scope, db, 'user')
  other = await createUser(scope, db, 'user')
  admin = await createUser(scope, db, 'admin')
  superAdmin = await createUser(scope, db, 'super_admin')
  outsider = await createUser(scope, db, 'retired_role')
})
beforeEach(() => memory.clear())
afterAll(() => scope.cleanup())

interface PostBody {
  id: string
  authorId: string
  title: string
  slug: string
  content: string
  status: 'draft' | 'published'
  createdAt: string
  updatedAt: string
}

function uniqueTitle(): string {
  titleCount++
  return `Route post ${scope.run.slice(0, 8)} ${titleCount}`
}

interface CallOptions {
  cookie?: string
  body?: unknown
  raw?: string
  // Sent as a browser on the web origin would; `null` leaves it out (utils/csrf).
  origin?: string | null
  headers?: Record<string, string>
}

function call(method: string, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = {}
  const origin = options.origin === undefined ? env.WEB_URL : options.origin
  if (origin !== null) headers.origin = origin
  if (options.cookie !== undefined) headers.cookie = options.cookie
  let body: string | undefined
  if (options.raw !== undefined || options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = options.raw ?? JSON.stringify(options.body)
  }
  return request(path, { method, headers: { ...headers, ...options.headers }, body })
}

async function createPost(caller: SignedInUser, overrides: Record<string, unknown> = {}): Promise<PostBody> {
  const response = await call('POST', '/api/posts', {
    cookie: caller.cookie,
    body: { title: uniqueTitle(), content: 'Content long enough.', ...overrides },
  })
  expect(response.status).toBe(201)
  return (await response.json()) as PostBody
}

async function expectValidationError(response: Response, fields: { path: string; rule: string }[]): Promise<void> {
  expect(response.status).toBe(400)
  expect(response.headers.get('x-request-id')).toBeString()
  expect(await response.json()).toEqual({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: { fields } })
}

async function expectStatus(response: Response, status: number, body?: unknown): Promise<void> {
  expect(response.status).toBe(status)
  expect(response.headers.get('x-request-id')).toBeString()
  if (body !== undefined) expect(await response.json()).toEqual(body)
}

describe('GET /api/posts', () => {
  test('200: a page of posts, newest first, with the list meta', async () => {
    const first = await createPost(author)
    const second = await createPost(other)

    const response = await call('GET', '/api/posts?limit=100', { cookie: author.cookie })

    await expectStatus(response, 200)
    const body = (await response.json()) as { items: PostBody[]; meta: Record<string, number> }
    const ids = body.items.map((item) => item.id)
    expect(ids).toContain(first.id)
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id))
    expect(body.items.find((item) => item.id === first.id)).toEqual(first)
    expect(body.meta).toEqual({
      page: 1,
      limit: 100,
      total: expect.any(Number),
      totalPages: Math.ceil((body.meta.total ?? 0) / 100),
    })
  })

  test('defaults to page 1, limit 20', async () => {
    await createPost(author)

    const body = (await (await call('GET', '/api/posts', { cookie: author.cookie })).json()) as {
      items: unknown[]
      meta: Record<string, number>
    }

    expect(body.meta).toMatchObject({ page: 1, limit: 20 })
    expect(body.items.length).toBeLessThanOrEqual(20)
  })

  test('a page past the end is an empty list, not an error', async () => {
    const response = await call('GET', '/api/posts?page=10000&limit=100', { cookie: author.cookie })

    await expectStatus(response, 200)
    const body = (await response.json()) as { items: unknown[]; meta: Record<string, number> }
    expect(body.items).toEqual([])
    expect(body.meta).toMatchObject({ page: 10000, limit: 100, total: expect.any(Number) })
  })

  test('400: limit over 100, or page and limit out of range, name the fields only', async () => {
    await expectValidationError(await call('GET', '/api/posts?limit=101', { cookie: author.cookie }), [
      { path: '/limit', rule: 'maximum' },
    ])
    await expectValidationError(await call('GET', '/api/posts?page=0&limit=0', { cookie: author.cookie }), [
      { path: '/page', rule: 'minimum' },
      { path: '/limit', rule: 'minimum' },
    ])
    await expectValidationError(await call('GET', '/api/posts?page=10001', { cookie: author.cookie }), [
      { path: '/page', rule: 'maximum' },
    ])
    await expectValidationError(await call('GET', '/api/posts?limit=abc', { cookie: author.cookie }), [
      { path: '/limit', rule: 'type' },
    ])
    await expectValidationError(await call('GET', '/api/posts?page=1.5', { cookie: author.cookie }), [
      { path: '/page', rule: 'type' },
    ])
  })

  test('401 without a session, 403 without posts:read', async () => {
    await expectStatus(await call('GET', '/api/posts'), 401, { code: 'UNAUTHORIZED', message: 'Sign in to continue' })
    await expectStatus(await call('GET', '/api/posts', { cookie: outsider.cookie }), 403, FORBIDDEN_BODY)
  })

  // The cache sits behind the permission check: a cached list is never served to a caller who
  // may not read it.
  test('a cached list is still refused to a guest and to a caller without posts:read', async () => {
    await createPost(author)
    const warm = await call('GET', '/api/posts?page=1', { cookie: author.cookie })
    expect(warm.status).toBe(200)
    expect((await call('GET', '/api/posts?page=1', { cookie: author.cookie })).status).toBe(200)

    await expectStatus(await call('GET', '/api/posts?page=1'), 401)
    await expectStatus(await call('GET', '/api/posts?page=1', { cookie: outsider.cookie }), 403, FORBIDDEN_BODY)
  })

  test('a cache hit returns exactly the payload of the miss', async () => {
    await createPost(author)
    const miss = await call('GET', '/api/posts?page=1', { cookie: author.cookie })
    const hit = await call('GET', '/api/posts?page=1', { cookie: other.cookie })

    expect(await hit.text()).toBe(await miss.text())
  })

  // Removing a user deletes their posts by cascade, past PostService; the cached pages go too.
  test('a cached list no longer shows the posts of a user an admin removed', async () => {
    const leaving = await createUser(scope, db, 'user')
    const theirs = await createPost(leaving)
    const warm = await call('GET', '/api/posts?page=1', { cookie: other.cookie })
    const warmBody = (await warm.json()) as { items: PostBody[] }
    expect(warmBody.items.map((item) => item.id)).toContain(theirs.id)

    const removed = await call('POST', '/api/auth/admin/remove-user', { cookie: superAdmin.cookie, body: { userId: leaving.id } })
    expect(removed.status).toBe(200)

    const after = await call('GET', '/api/posts?page=1', { cookie: other.cookie })
    expect(after.status).toBe(200)
    const afterBody = (await after.json()) as { items: PostBody[] }
    expect(afterBody.items.map((item) => item.id)).not.toContain(theirs.id)
    await expectStatus(await call('GET', `/api/posts/${theirs.id}`, { cookie: other.cookie }), 404, NOT_FOUND_BODY)
  })
})

describe('GET /api/posts/:id', () => {
  test('200: the post', async () => {
    const created = await createPost(author)

    const response = await call('GET', `/api/posts/${created.id}`, { cookie: other.cookie })

    await expectStatus(response, 200, created)
  })

  test('400: an id that is not a UUID', async () => {
    await expectValidationError(await call('GET', '/api/posts/not-a-uuid', { cookie: author.cookie }), [
      { path: '/id', rule: 'format' },
    ])
  })

  test('401 without a session, 403 without posts:read', async () => {
    const created = await createPost(author)

    await expectStatus(await call('GET', `/api/posts/${created.id}`), 401)
    await expectStatus(await call('GET', `/api/posts/${created.id}`, { cookie: outsider.cookie }), 403, FORBIDDEN_BODY)
  })

  test('404 POST_NOT_FOUND for an unknown id', async () => {
    await expectStatus(await call('GET', `/api/posts/${MISSING_ID}`, { cookie: author.cookie }), 404, NOT_FOUND_BODY)
  })
})

describe('POST /api/posts', () => {
  test('201: created as a draft by the caller, with a slug from the title', async () => {
    const response = await call('POST', '/api/posts', {
      cookie: author.cookie,
      body: { title: 'Héllo, World! Route', content: 'Content long enough.' },
    })

    await expectStatus(response, 201)
    const created = (await response.json()) as PostBody
    expect(created).toEqual({
      id: expect.any(String),
      authorId: author.id,
      title: 'Héllo, World! Route',
      slug: expect.stringMatching(/^hello-world-route(-[a-z0-9]{6})?$/),
      content: 'Content long enough.',
      status: 'draft',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt)
    const [row] = await db.select().from(post).where(eq(post.id, created.id))
    expect(row?.authorId).toBe(author.id)
  })

  test('201: status published, and the length limits are inclusive', async () => {
    const created = await createPost(author, {
      status: 'published',
      title: `${uniqueTitle()} `.padEnd(titleMaxLength, 'x'),
      content: 'c'.repeat(contentMaxLength),
    })

    expect(created.status).toBe('published')
    expect(created.title).toHaveLength(titleMaxLength)
    expect(created.content).toHaveLength(contentMaxLength)
  })

  test('the same title twice gets a suffixed slug', async () => {
    const title = uniqueTitle()
    const first = await createPost(author, { title })
    const second = await createPost(other, { title })

    expect(second.slug).toStartWith(`${first.slug}-`)
    expect(second.slug).not.toBe(first.slug)
  })

  test('400: lengths, status and missing fields, with paths and rules only', async () => {
    await expectValidationError(
      await call('POST', '/api/posts', { cookie: author.cookie, body: { title: 'ab', content: 'short' } }),
      [
        { path: '/title', rule: 'minLength' },
        { path: '/content', rule: 'minLength' },
      ],
    )
    await expectValidationError(
      await call('POST', '/api/posts', {
        cookie: author.cookie,
        body: { title: 't'.repeat(titleMaxLength + 1), content: 'c'.repeat(contentMaxLength + 1) },
      }),
      [
        { path: '/title', rule: 'maxLength' },
        { path: '/content', rule: 'maxLength' },
      ],
    )
    // A missing field is a wrong type, as API.md §2 says.
    await expectValidationError(await call('POST', '/api/posts', { cookie: author.cookie, body: {} }), [
      { path: '/title', rule: 'type' },
      { path: '/content', rule: 'type' },
    ])
    const badStatus = await call('POST', '/api/posts', {
      cookie: author.cookie,
      body: { title: uniqueTitle(), content: 'Content long enough.', status: 'archived' },
    })
    expect(badStatus.status).toBe(400)
    expect(await badStatus.json()).toMatchObject({ details: { fields: [expect.objectContaining({ path: '/status' })] } })
  })

  test('slug and authorId in the body are ignored: the caller is the author, the slug comes from the title', async () => {
    const title = uniqueTitle()
    const created = await createPost(author, { title, slug: 'chosen-slug', authorId: other.id })

    expect(created.authorId).toBe(author.id)
    expect(created.slug).toStartWith('route-post-')
  })

  test('400: a body that is not JSON', async () => {
    const response = await call('POST', '/api/posts', { cookie: author.cookie, raw: '{"title": "unterminated' })

    await expectStatus(response, 400, { code: 'VALIDATION_ERROR', message: 'Invalid request' })
  })

  test('the 400 response never echoes the submitted values', async () => {
    const secret = 'super-secret-value-123'
    const response = await call('POST', '/api/posts', { cookie: author.cookie, body: { title: 'ab', content: secret } })

    expect(await response.text()).not.toContain(secret)
    expect(JSON.stringify(memory.find('http.error'))).not.toContain(secret)
  })

  test('401 without a session, 403 without posts:write', async () => {
    const body = { title: uniqueTitle(), content: 'Content long enough.' }

    await expectStatus(await call('POST', '/api/posts', { body }), 401)
    await expectStatus(await call('POST', '/api/posts', { cookie: outsider.cookie, body }), 403, FORBIDDEN_BODY)
  })
})

describe('PATCH /api/posts/:id', () => {
  test('200: the author edits; the slug and author stay', async () => {
    const created = await createPost(author)

    const response = await call('PATCH', `/api/posts/${created.id}`, {
      cookie: author.cookie,
      body: { title: 'A brand new title', status: 'published' },
    })

    await expectStatus(response, 200)
    const updated = (await response.json()) as PostBody
    expect(updated).toEqual({
      ...created,
      title: 'A brand new title',
      status: 'published',
      updatedAt: expect.any(String),
    })
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt))
  })

  test('fields left out keep their value: a published post stays published', async () => {
    const created = await createPost(author, { status: 'published' })

    const response = await call('PATCH', `/api/posts/${created.id}`, { cookie: author.cookie, body: { content: 'Only the content changes.' } })

    expect(((await response.json()) as PostBody).status).toBe('published')
    const [row] = await db.select({ status: post.status, slug: post.slug }).from(post).where(eq(post.id, created.id))
    expect(row).toEqual({ status: 'published', slug: created.slug })
  })

  test('403: another user cannot edit, and the post is unchanged', async () => {
    const created = await createPost(author)

    const response = await call('PATCH', `/api/posts/${created.id}`, { cookie: other.cookie, body: { title: 'Taken over' } })

    await expectStatus(response, 403, FORBIDDEN_BODY)
    const [row] = await db.select({ title: post.title }).from(post).where(eq(post.id, created.id))
    expect(row?.title).toBe(created.title)
  })

  test('200: admin and super_admin (posts:manage_all) edit anyone’s post', async () => {
    const created = await createPost(author)

    const byAdmin = await call('PATCH', `/api/posts/${created.id}`, { cookie: admin.cookie, body: { content: 'Edited by an admin.' } })
    await expectStatus(byAdmin, 200)
    expect(((await byAdmin.json()) as PostBody).authorId).toBe(author.id)

    const bySuperAdmin = await call('PATCH', `/api/posts/${created.id}`, { cookie: superAdmin.cookie, body: { status: 'published' } })
    await expectStatus(bySuperAdmin, 200)
  })

  test('400: an empty body, an unknown field, a bad length or a bad id', async () => {
    const created = await createPost(author)

    await expectValidationError(await call('PATCH', `/api/posts/${created.id}`, { cookie: author.cookie, body: {} }), [
      { path: '', rule: 'minProperties' },
    ])
    // Only unknown fields: nothing writable is left.
    await expectValidationError(await call('PATCH', `/api/posts/${created.id}`, { cookie: author.cookie, body: { slug: 'renamed' } }), [
      { path: '', rule: 'minProperties' },
    ])
    await expectValidationError(await call('PATCH', `/api/posts/${created.id}`, { cookie: author.cookie, body: { title: 'ab' } }), [
      { path: '/title', rule: 'minLength' },
    ])
    await expectValidationError(await call('PATCH', '/api/posts/123', { cookie: author.cookie, body: { title: 'Valid title' } }), [
      { path: '/id', rule: 'format' },
    ])
  })

  // Audit regression: a field outside the update schema is dropped, never written.
  test('authorId in the body is ignored: the author stays', async () => {
    const created = await createPost(author)

    const response = await call('PATCH', `/api/posts/${created.id}`, {
      cookie: author.cookie,
      body: { title: 'Handed to someone else', authorId: other.id },
    })

    await expectStatus(response, 200)
    expect(((await response.json()) as PostBody).authorId).toBe(author.id)
    const [row] = await db.select({ authorId: post.authorId, title: post.title }).from(post).where(eq(post.id, created.id))
    expect(row).toEqual({ authorId: author.id, title: 'Handed to someone else' })
  })

  test('401 without a session, 403 without posts:write, 404 for an unknown id', async () => {
    const created = await createPost(author)
    const body = { title: 'Valid title' }

    await expectStatus(await call('PATCH', `/api/posts/${created.id}`, { body }), 401)
    await expectStatus(await call('PATCH', `/api/posts/${created.id}`, { cookie: outsider.cookie, body }), 403, FORBIDDEN_BODY)
    await expectStatus(await call('PATCH', `/api/posts/${MISSING_ID}`, { cookie: author.cookie, body }), 404, NOT_FOUND_BODY)
    await expectStatus(await call('PATCH', `/api/posts/${MISSING_ID}`, { cookie: admin.cookie, body }), 404, NOT_FOUND_BODY)
  })
})

describe('DELETE /api/posts/:id', () => {
  test('204: the author deletes, then the post is gone', async () => {
    const created = await createPost(author)

    const response = await call('DELETE', `/api/posts/${created.id}`, { cookie: author.cookie })

    await expectStatus(response, 204)
    expect(await response.text()).toBe('')
    await expectStatus(await call('GET', `/api/posts/${created.id}`, { cookie: author.cookie }), 404, NOT_FOUND_BODY)
  })

  test('403: another user cannot delete, and the post stays', async () => {
    const created = await createPost(author)

    await expectStatus(await call('DELETE', `/api/posts/${created.id}`, { cookie: other.cookie }), 403, FORBIDDEN_BODY)
    await expectStatus(await call('GET', `/api/posts/${created.id}`, { cookie: other.cookie }), 200)
  })

  test('204: admin deletes anyone’s post', async () => {
    const created = await createPost(author)

    await expectStatus(await call('DELETE', `/api/posts/${created.id}`, { cookie: admin.cookie }), 204)
  })

  test('400 for a bad id, 401 without a session, 403 without posts:write, 404 for an unknown id', async () => {
    const created = await createPost(author)

    await expectValidationError(await call('DELETE', '/api/posts/nope', { cookie: author.cookie }), [{ path: '/id', rule: 'format' }])
    await expectStatus(await call('DELETE', `/api/posts/${created.id}`), 401)
    await expectStatus(await call('DELETE', `/api/posts/${created.id}`, { cookie: outsider.cookie }), 403, FORBIDDEN_BODY)
    await expectStatus(await call('DELETE', `/api/posts/${MISSING_ID}`, { cookie: author.cookie }), 404, NOT_FOUND_BODY)
  })
})

// A 500 after a committed POST makes the client retry and create the post twice, so a cache that
// fails after the write is a warning, never the response.
describe('writes with the posts cache failing', () => {
  // Only the posts keys fail: the session check before the handler uses the same store.
  async function withPostsCacheDown(run: () => Promise<Response>): Promise<Response> {
    const set = cacheStore.set.bind(cacheStore)
    const spy = spyOn(cacheStore, 'set').mockImplementation(async (key, value, ttlSeconds) => {
      if (key.startsWith('posts:')) throw new Error('Redis command timed out after 1000 ms')
      return set(key, value, ttlSeconds)
    })
    try {
      return await run()
    } finally {
      spy.mockRestore()
    }
  }

  function expectOneWarning(): void {
    expect(memory.find('cache.invalidation_failed')).toEqual([
      expect.objectContaining({ level: 'warn', module: 'posts', cacheModule: 'posts', stage: 'generation' }),
    ])
    expect(memory.find('http.error')).toEqual([])
  }

  test('POST is 201 with the created post', async () => {
    const title = uniqueTitle()

    const response = await withPostsCacheDown(() =>
      call('POST', '/api/posts', { cookie: author.cookie, body: { title, content: 'Content long enough.' } }),
    )

    await expectStatus(response, 201)
    const created = (await response.json()) as PostBody
    expect(created.title).toBe(title)
    const rows = await db.select({ id: post.id }).from(post).where(eq(post.title, title))
    expect(rows).toEqual([{ id: created.id }])
    expectOneWarning()
    expect(JSON.stringify(memory.find('cache.invalidation_failed'))).not.toContain(title)
  })

  test('PATCH is 200 with the updated post', async () => {
    const created = await createPost(author)
    memory.clear()

    const response = await withPostsCacheDown(() =>
      call('PATCH', `/api/posts/${created.id}`, { cookie: author.cookie, body: { status: 'published' } }),
    )

    await expectStatus(response, 200)
    expect(((await response.json()) as PostBody).status).toBe('published')
    expectOneWarning()
  })

  test('DELETE is 204 and the post is gone', async () => {
    const created = await createPost(author)
    memory.clear()

    const response = await withPostsCacheDown(() => call('DELETE', `/api/posts/${created.id}`, { cookie: author.cookie }))

    await expectStatus(response, 204)
    expectOneWarning()
    await expectStatus(await call('GET', `/api/posts/${created.id}`, { cookie: author.cookie }), 404, NOT_FOUND_BODY)
  })

  // The removal's cascade invalidates from the auth hook, so the request is logged under `auth`
  // while `cacheModule` names the cache that missed the write.
  test('an admin removing a user is 200, and the warning names both modules', async () => {
    const leaving = await createUser(scope, db, 'user')
    const theirs = await createPost(leaving)
    memory.clear()

    const response = await withPostsCacheDown(() =>
      call('POST', '/api/auth/admin/remove-user', { cookie: superAdmin.cookie, body: { userId: leaving.id } }),
    )

    expect(response.status).toBe(200)
    expect(memory.find('cache.invalidation_failed')).toEqual([
      expect.objectContaining({ level: 'warn', module: 'auth', cacheModule: 'posts', stage: 'generation' }),
    ])
    expect(memory.find('http.error')).toEqual([])
    await expectStatus(await call('GET', `/api/posts/${theirs.id}`, { cookie: author.cookie }), 404, NOT_FOUND_BODY)
  })
})

// API.md §1: the CSRF guard (utils/csrf) in front of every posts write, on the real app.
describe('CSRF guard', () => {
  const CSRF_BODY = { code: 'CSRF_REJECTED', message: 'Cross-site request refused' }
  const crossSite = { 'sec-fetch-site': 'cross-site' }
  const refusals: [string, Pick<CallOptions, 'origin' | 'headers'>][] = [
    ['Sec-Fetch-Site: cross-site', { origin: null, headers: crossSite }],
    ['Sec-Fetch-Site: same-site', { origin: null, headers: { 'sec-fetch-site': 'same-site' } }],
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['a cookie with neither header', { origin: null }],
  ]

  async function authorsPostCount(): Promise<number> {
    return (await db.select({ id: post.id }).from(post).where(eq(post.authorId, author.id))).length
  }

  test.each(refusals)('POST with %s is 403 and nothing is created', async (_case, headers) => {
    const before = await authorsPostCount()

    const response = await call('POST', '/api/posts', {
      cookie: author.cookie,
      body: { title: uniqueTitle(), content: 'Content long enough.' },
      ...headers,
    })

    await expectStatus(response, 403, CSRF_BODY)
    expect(await authorsPostCount()).toBe(before)
    expect(memory.find('audit.csrf.rejected')).toEqual([expect.objectContaining({ method: 'POST' })])
  })

  test.each(refusals)('PATCH with %s is 403 and the post is unchanged', async (_case, headers) => {
    const created = await createPost(author)

    const response = await call('PATCH', `/api/posts/${created.id}`, {
      cookie: author.cookie,
      body: { title: 'Changed cross-site' },
      ...headers,
    })

    await expectStatus(response, 403, CSRF_BODY)
    const [row] = await db.select({ title: post.title }).from(post).where(eq(post.id, created.id))
    expect(row?.title).toBe(created.title)
  })

  test.each(refusals)('DELETE with %s is 403 and the post stays', async (_case, headers) => {
    const created = await createPost(author)

    const response = await call('DELETE', `/api/posts/${created.id}`, { cookie: author.cookie, ...headers })

    await expectStatus(response, 403, CSRF_BODY)
    expect(await db.select({ id: post.id }).from(post).where(eq(post.id, created.id))).toHaveLength(1)
  })

  test('Sec-Fetch-Site: same-origin without Origin creates, edits and deletes', async () => {
    const sameOrigin = { origin: null, headers: { 'sec-fetch-site': 'same-origin' } }

    const created = await call('POST', '/api/posts', {
      cookie: author.cookie,
      body: { title: uniqueTitle(), content: 'Content long enough.' },
      ...sameOrigin,
    })
    await expectStatus(created, 201)
    const { id } = (await created.json()) as PostBody
    await expectStatus(await call('PATCH', `/api/posts/${id}`, { cookie: author.cookie, body: { status: 'published' }, ...sameOrigin }), 200)
    await expectStatus(await call('DELETE', `/api/posts/${id}`, { cookie: author.cookie, ...sameOrigin }), 204)
  })

  test('no cookie and neither header falls through to the usual 401', async () => {
    const response = await call('POST', '/api/posts', { body: { title: uniqueTitle(), content: 'Content long enough.' }, origin: null })

    await expectStatus(response, 401, { code: 'UNAUTHORIZED', message: 'Sign in to continue' })
    expect(memory.find('audit.csrf.rejected')).toEqual([])
  })

  test('GET is never checked', async () => {
    const response = await call('GET', '/api/posts', { cookie: author.cookie, origin: 'https://evil.example', headers: crossSite })

    await expectStatus(response, 200)
  })

  test.each([
    ['application/x-www-form-urlencoded', 'title=Form+post+title&content=Content+long+enough.'],
    ['multipart/form-data; boundary=x', '--x\r\nContent-Disposition: form-data; name="title"\r\n\r\nForm post title\r\n--x--\r\n'],
    ['text/plain', JSON.stringify({ title: 'Form post title', content: 'Content long enough.' })],
  ])('%s POST is 415 and nothing is created', async (type, raw) => {
    const before = await authorsPostCount()

    const response = await request('/api/posts', {
      method: 'POST',
      headers: { origin: env.WEB_URL, cookie: author.cookie, 'content-type': type },
      body: raw,
    })

    await expectStatus(response, 415, { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The request body must be application/json' })
    expect(await authorsPostCount()).toBe(before)
  })

  // Better Auth's mount is untouched: its own answer, never the guard's. Its own origin check is on in
  // tests too (pinned in packages/auth), so the answer is Better Auth's 403 for the missing Origin.
  test('/api/auth/* is not checked by the guard', async () => {
    const response = await request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': uniqueIp(), ...crossSite },
      body: JSON.stringify({ email: author.email, password: 'wrong-password-123' }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'MISSING_OR_NULL_ORIGIN' })
    expect(memory.find('audit.csrf.rejected')).toEqual([])
  })
})

describe('logging (module: posts)', () => {
  test('a forced error is one http.error with module posts and no route field; the client sees 500 only', async () => {
    const spy = spyOn(PostService, 'list').mockRejectedValue(new Error('database exploded: password=hunter2'))
    try {
      const response = await call('GET', '/api/posts', { cookie: author.cookie })

      await expectStatus(response, 500, { code: 'INTERNAL_ERROR', message: 'Internal server error' })
      const errors = memory.find('http.error')
      expect(errors).toEqual([expect.objectContaining({ module: 'posts', status: 500, code: 'INTERNAL_ERROR' })])
      expect(errors[0]).not.toHaveProperty('route')
    } finally {
      spy.mockRestore()
    }
  })

  test('a moduleError carries sourceModule posts', async () => {
    await call('GET', `/api/posts/${MISSING_ID}`, { cookie: author.cookie })

    expect(memory.find('http.error')).toEqual([
      expect.objectContaining({ module: 'posts', sourceModule: 'posts', status: 404, code: 'POST_NOT_FOUND' }),
    ])
  })

  test('the ownership 403 is a posts moduleError; the permission 403 is the macro’s', async () => {
    const created = await createPost(author)
    memory.clear()

    await call('DELETE', `/api/posts/${created.id}`, { cookie: other.cookie })
    await call('GET', '/api/posts', { cookie: outsider.cookie })

    const [ownership, permission] = memory.find('http.error')
    expect(ownership).toMatchObject({ module: 'posts', sourceModule: 'posts', status: 403, code: 'FORBIDDEN' })
    expect(permission).toMatchObject({ module: 'posts', status: 403, code: 'FORBIDDEN' })
    expect(permission).not.toHaveProperty('sourceModule')
  })

  test('validation, 401 and success are tagged posts too, with the caller id when signed in', async () => {
    await call('GET', '/api/posts?limit=500', { cookie: author.cookie })
    await call('GET', '/api/posts')
    await call('GET', '/api/posts', { cookie: author.cookie })

    expect(memory.find('http.request')).toEqual([
      expect.objectContaining({ module: 'posts', route: '/api/posts', status: 400 }),
      expect.objectContaining({ module: 'posts', route: '/api/posts', status: 401 }),
      expect.objectContaining({ module: 'posts', route: '/api/posts', status: 200, userId: author.id }),
    ])
  })
})

// FEATURES.md F-04: p95 on a cache hit < 50 ms, read from `http.request` (in-process, memory cache).
describe('cache-hit latency', () => {
  test('p95 of http.request durationMs over 200 hits is under 50 ms', async () => {
    await createPost(author)
    const path = '/api/posts?page=1&limit=20'
    expect((await call('GET', path, { cookie: author.cookie })).status).toBe(200)
    memory.clear()

    const samples = 200
    for (let index = 0; index < samples; index++) await call('GET', path, { cookie: author.cookie })

    const durations = memory
      .find('http.request')
      .filter((event) => event.route === '/api/posts' && event.status === 200)
      .map((event) => Number(event.durationMs))
      .sort((a, b) => a - b)
    expect(durations).toHaveLength(samples)
    const p95 = durations[Math.ceil(samples * 0.95) - 1] ?? Number.POSITIVE_INFINITY
    expect(p95).toBeLessThan(50)
  })
})

// The length limits are product numbers with no default (TASK-08): the app must not build without them.
describe('startup', () => {
  const importApp = 'await import("./src/app.ts")'

  test.each([
    [{ POSTS_TITLE_MAX_LENGTH: '' }, 'POSTS_TITLE_MAX_LENGTH must be set'],
    [{ POSTS_CONTENT_MAX_LENGTH: '' }, 'POSTS_CONTENT_MAX_LENGTH must be set'],
    [{ POSTS_TITLE_MAX_LENGTH: '2' }, 'POSTS_TITLE_MAX_LENGTH must be at least 3'],
    [{ POSTS_CONTENT_MAX_LENGTH: '9' }, 'POSTS_CONTENT_MAX_LENGTH must be at least 10'],
  ])('%p fails startup', async (overrides, message) => {
    const result = await runInApiProcess(importApp, { LOG_LEVEL: 'silent', ...overrides })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(message)
  })

  test('builds with both limits set', async () => {
    const result = await runInApiProcess(importApp, { LOG_LEVEL: 'silent', POSTS_TITLE_MAX_LENGTH: '3', POSTS_CONTENT_MAX_LENGTH: '10' })

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
  })
})
