import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test'
import { post } from '@repo/db'
import { eq } from 'drizzle-orm'
import { env } from '../../../src/env'
import { LIST_DEFAULT_LIMIT } from '../../../src/modules/posts/model'
import { PostService, slugify, type Actor } from '../../../src/modules/posts/service'
import { cacheStore } from '../../../src/utils/cache'
import { ModuleError } from '../../../src/utils/error'
import { telemetry } from '../../../src/utils/telemetry'
import { createMemorySink } from '../../../src/utils/telemetry/sinks/memory'
import { fixtures, testDb } from '../../helpers/db'

// PostService against the test database and the memory cache (REDIS_URL is empty in tests). The
// database is shared, so every list assertion looks at the posts made here, never at totals alone.

const db = await testDb()
const scope = fixtures(db)
const MISSING_ID = '00000000-0000-4000-8000-000000000000'
// A page size the service caches (the default), and one it does not.
const CACHED = LIST_DEFAULT_LIMIT
const UNCACHED = 11
const memory = createMemorySink()
const detachMemory = telemetry.addSink(memory)
let author: Actor
let other: Actor
let titleCount = 0

beforeAll(async () => {
  author = { id: (await scope.user({ role: 'user' })).id, role: 'user' }
  other = { id: (await scope.user({ role: 'user' })).id, role: 'user' }
})
beforeEach(() => memory.clear())
afterAll(async () => {
  detachMemory()
  await scope.cleanup()
})

function uniqueTitle(): string {
  titleCount++
  return `Service post ${scope.run.slice(0, 8)} ${titleCount}`
}

function create(actor: Actor = author, overrides: { title?: string; status?: 'draft' | 'published' } = {}) {
  return PostService.create(actor.id, { title: uniqueTitle(), content: 'Content long enough.', ...overrides })
}

// A row written straight to PostgreSQL, past the service, so it does not clear the cache.
async function insertBehindTheCache(authorId: string): Promise<string> {
  const [row] = await db
    .insert(post)
    .values({ authorId, title: uniqueTitle(), slug: `behind-${crypto.randomUUID()}`, content: 'Inserted directly.' })
    .returning({ id: post.id })
  if (row === undefined) throw new Error('insert returned no row')
  return row.id
}

// The list generation (service.ts) and the key a page is cached under while it is current.
async function generation(): Promise<string | undefined> {
  const stored = await cacheStore.get('posts:generation:list')
  return stored === null ? undefined : (JSON.parse(stored) as string)
}

async function pageKey(page: number, limit: number): Promise<string> {
  return `posts:list:${await generation()}:${page}:${limit}`
}

async function expectModuleError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(ModuleError)
  expect(error).toMatchObject({ sourceModule: 'posts', status, code })
}

describe('slugify', () => {
  test.each([
    ['Hello World', 'hello-world'],
    ['  Héllo, Wörld!  ', 'hello-world'],
    ['Crème brûlée -- 2026', 'creme-brulee-2026'],
    ['---', 'post'],
    ['日本語のタイトル', 'post'],
  ])('%p → %p', (title, slug) => {
    expect(slugify(title)).toBe(slug)
  })

  test('is at most 64 characters and never ends with a dash', () => {
    const slug = slugify(`${'a'.repeat(63)} b`)

    expect(slug.length).toBeLessThanOrEqual(64)
    expect(slug).toBe('a'.repeat(63))
  })
})

describe('PostService.create', () => {
  test('the caller is the author, status defaults to draft, dates are ISO strings', async () => {
    const created = await create()

    expect(created).toMatchObject({ authorId: author.id, status: 'draft', content: 'Content long enough.' })
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt)
    const [row] = await db.select().from(post).where(eq(post.id, created.id))
    expect(row?.slug).toBe(created.slug)
  })

  test('a taken slug gets a 6-character suffix', async () => {
    const title = uniqueTitle()
    const first = await create(author, { title })
    const second = await create(other, { title })
    const third = await create(author, { title })

    expect(first.slug).toBe(slugify(title))
    expect(second.slug).toMatch(new RegExp(`^${first.slug}-[a-z0-9]{6}$`))
    expect(new Set([first.slug, second.slug, third.slug]).size).toBe(3)
  })
})

describe('PostService.get', () => {
  test('returns the post, or POST_NOT_FOUND', async () => {
    const created = await create()

    expect(await PostService.get(created.id)).toEqual(created)
    await expectModuleError(PostService.get(MISSING_ID), 404, 'POST_NOT_FOUND')
  })
})

describe('PostService.list and its cache', () => {
  test('a hit is exactly the miss payload, and is served from the cache', async () => {
    await create()
    const miss = await PostService.list(1, CACHED)

    const behind = await insertBehindTheCache(author.id)
    const hit = await PostService.list(1, CACHED)

    expect(JSON.stringify(hit)).toBe(JSON.stringify(miss))
    expect(hit.items.map((item) => item.id)).not.toContain(behind)
  })

  test('is stored under posts:list:{generation}:{page}:{limit} as the JSON of the payload', async () => {
    const list = await PostService.list(1, CACHED)

    expect(await cacheStore.get(await pageKey(1, CACHED))).toBe(JSON.stringify(list))
  })

  test('a page past the end is empty and is not cached', async () => {
    const empty = await PostService.list(10_000, CACHED)

    expect(empty.items).toEqual([])
    expect(empty.meta).toMatchObject({ page: 10_000, limit: CACHED })
    expect(await cacheStore.get(await pageKey(10_000, CACHED))).toBeNull()
  })

  test('create replaces the generation and clears every cached page', async () => {
    await PostService.list(1, CACHED)
    await PostService.list(2, CACHED)
    const before = await generation()
    const oldPages = [await pageKey(1, CACHED), await pageKey(2, CACHED)]

    const created = await create()

    expect(await generation()).not.toBe(before)
    for (const key of oldPages) expect(await cacheStore.get(key)).toBeNull()
    expect((await PostService.list(1, CACHED)).items.map((item) => item.id)).toContain(created.id)
  })

  test('update clears the cached pages and the next list shows the change', async () => {
    const created = await create()
    await PostService.list(1, CACHED)
    const oldPage = await pageKey(1, CACHED)

    await PostService.update(created.id, { title: 'Renamed in the service' }, author)

    expect(await cacheStore.get(oldPage)).toBeNull()
    const listed = (await PostService.list(1, CACHED)).items.find((item) => item.id === created.id)
    expect(listed?.title).toBe('Renamed in the service')
  })

  test('delete clears the cached pages and the post leaves the list', async () => {
    const created = await create()
    await PostService.list(1, CACHED)
    const oldPage = await pageKey(1, CACHED)

    await PostService.remove(created.id, author)

    expect(await cacheStore.get(oldPage)).toBeNull()
    expect((await PostService.list(1, CACHED)).items.map((item) => item.id)).not.toContain(created.id)
  })

  // A load that read the database before a write finishes after it: its page goes under the old
  // generation, so no request that starts after the write is served the deleted post.
  test('a load paused across a delete cannot put the deleted post back in the cache', async () => {
    const doomed = await create()
    const loaded = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const set = cacheStore.set.bind(cacheStore)
    let paused = false
    const spy = spyOn(cacheStore, 'set').mockImplementation(async (key, value, ttlSeconds) => {
      // The first page write comes after the loader's database read: hold it there.
      if (!paused && key.startsWith('posts:list:')) {
        paused = true
        loaded.resolve()
        await resume.promise
      }
      return set(key, value, ttlSeconds)
    })
    try {
      const stale = PostService.list(1, CACHED)
      await loaded.promise

      await PostService.remove(doomed.id, author)
      resume.resolve()

      expect((await stale).items.map((item) => item.id)).toContain(doomed.id)
      expect((await PostService.list(1, CACHED)).items.map((item) => item.id)).not.toContain(doomed.id)
    } finally {
      spy.mockRestore()
    }
  })

  test('a missing generation is replaced before the load', async () => {
    await cacheStore.del(['posts:generation:list'])

    const list = await PostService.list(1, CACHED)

    expect(await generation()).toBeString()
    expect(await cacheStore.get(await pageKey(1, CACHED))).toBe(JSON.stringify(list))
  })

  test('another module’s keys survive a posts write', async () => {
    await cacheStore.set('other:list:1:20', 'kept', 60)

    await create()

    expect(await cacheStore.get('other:list:1:20')).toBe('kept')
    await cacheStore.del(['other:list:1:20'])
  })

  test('meta counts pages from the total', async () => {
    await create()
    const { meta } = await PostService.list(1, 3)

    expect(meta.totalPages).toBe(Math.ceil(meta.total / 3))
    expect(meta.total).toBeGreaterThanOrEqual(1)
  })

  // Each cached page size is another copy of every post, so a caller cycling through limits 1-100
  // must not be able to fill Redis.
  test('a page size outside the cached ones is read from PostgreSQL every time and caches nothing', async () => {
    await create()
    const set = spyOn(cacheStore, 'set')
    try {
      const first = await PostService.list(1, UNCACHED)
      const behind = await insertBehindTheCache(author.id)
      const second = await PostService.list(1, UNCACHED)

      expect(first.meta.limit).toBe(UNCACHED)
      expect(first.items.map((item) => item.id)).not.toContain(behind)
      expect(second.items.map((item) => item.id)).toContain(behind)
      expect(set).not.toHaveBeenCalled()
    } finally {
      set.mockRestore()
    }
  })
})

// The write commits before the cache is touched, so a cache failure must not fail the call: a 500
// after a committed POST makes the client retry and create the post twice.
describe('a cache failure after a committed write', () => {
  const REDIS_DOWN = new Error('Redis command timed out after 1000 ms')

  // `set` is the generation bump, `delPattern` the page sweep that follows it.
  async function withCacheFailing<T>(step: 'set' | 'delPattern', run: () => Promise<T>): Promise<T> {
    const spy =
      step === 'set'
        ? spyOn(cacheStore, 'set').mockRejectedValue(REDIS_DOWN)
        : spyOn(cacheStore, 'delPattern').mockRejectedValue(REDIS_DOWN)
    try {
      return await run()
    } finally {
      spy.mockRestore()
    }
  }

  function expectOneWarning(stage: 'generation' | 'pages', ...secrets: string[]): void {
    const failures = memory.find('cache.invalidation_failed')
    expect(failures).toEqual([
      expect.objectContaining({ level: 'warn', cacheModule: 'posts', stage, err: expect.objectContaining({ message: REDIS_DOWN.message }) }),
    ])
    for (const secret of secrets) expect(JSON.stringify(failures)).not.toContain(secret)
  }

  test('create returns the post it committed and emits one warning without its content', async () => {
    const title = uniqueTitle()

    const created = await withCacheFailing('set', () =>
      PostService.create(author.id, { title, content: 'Content that stays out of the log.' }),
    )

    expect(created.title).toBe(title)
    expect(await PostService.get(created.id)).toEqual(created)
    expectOneWarning('generation', title, 'Content that stays out of the log.')
  })

  test('update returns the post it committed and emits one warning', async () => {
    const created = await create()

    const updated = await withCacheFailing('set', () => PostService.update(created.id, { title: 'Renamed past a dead cache' }, author))

    expect(updated.title).toBe('Renamed past a dead cache')
    expect((await PostService.get(created.id)).title).toBe('Renamed past a dead cache')
    expectOneWarning('generation', 'Renamed past a dead cache')
  })

  test('remove resolves once the delete is committed and emits one warning', async () => {
    const created = await create()

    await withCacheFailing('set', () => PostService.remove(created.id, author))

    await expectModuleError(PostService.get(created.id), 404, 'POST_NOT_FOUND')
    expectOneWarning('generation')
  })

  // The documented cost: with the generation unchanged, a page cached before the write is served
  // until it expires (at most POSTS_CACHE_TTL).
  test('when the generation cannot be replaced, a cached page misses the write until it expires, then shows it', async () => {
    await PostService.list(1, CACHED)

    const created = await withCacheFailing('set', () => create())

    expect((await PostService.list(1, CACHED)).items.map((item) => item.id)).not.toContain(created.id)
    expectOneWarning('generation')

    // Page and generation share the TTL, so once it passes the next read loads afresh.
    setSystemTime(Date.now() + (env.POSTS_CACHE_TTL + 1) * 1000)
    try {
      expect((await PostService.list(1, CACHED)).items.map((item) => item.id)).toContain(created.id)
    } finally {
      setSystemTime()
    }
  })

  test('when only the page sweep fails, the next list already shows the write', async () => {
    await PostService.list(1, CACHED)

    const created = await withCacheFailing('delPattern', () => create())

    expect((await PostService.list(1, CACHED)).items.map((item) => item.id)).toContain(created.id)
    expectOneWarning('pages')
  })
})

describe('PostService.update and remove: the ownership rule', () => {
  test('the author may; another user is FORBIDDEN and nothing changes', async () => {
    const created = await create()

    expect((await PostService.update(created.id, { content: 'Edited by its author.' }, author)).content).toBe('Edited by its author.')
    await expectModuleError(PostService.update(created.id, { title: 'Not mine' }, other), 403, 'FORBIDDEN')
    await expectModuleError(PostService.remove(created.id, other), 403, 'FORBIDDEN')
    expect((await PostService.get(created.id)).title).toBe(created.title)
  })

  test('a role holding posts:manage_all may change anyone’s post', async () => {
    const created = await create()

    await PostService.update(created.id, { status: 'published' }, { id: other.id, role: 'admin' })
    await PostService.update(created.id, { status: 'draft' }, { id: other.id, role: 'super_admin' })
    // Better Auth's rule: any held role that grants it is enough.
    await PostService.update(created.id, { status: 'published' }, { id: other.id, role: 'retired_role,admin' })
    await PostService.remove(created.id, { id: other.id, role: 'admin' })

    await expectModuleError(PostService.get(created.id), 404, 'POST_NOT_FOUND')
  })

  test('NULL is user and an unknown role grants nothing', async () => {
    const created = await create()

    await expectModuleError(PostService.update(created.id, { title: 'Null role' }, { id: other.id, role: null }), 403, 'FORBIDDEN')
    await expectModuleError(PostService.remove(created.id, { id: other.id, role: 'constructor' }), 403, 'FORBIDDEN')
  })

  test('the slug and author never change on update; updatedAt moves forward', async () => {
    const created = await create()

    const updated = await PostService.update(created.id, { title: 'Completely different' }, { id: other.id, role: 'admin' })

    expect(updated.slug).toBe(created.slug)
    expect(updated.authorId).toBe(author.id)
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt))
    expect(updated.createdAt).toBe(created.createdAt)
  })

  test('a missing post is POST_NOT_FOUND, for the author and for an admin alike', async () => {
    await expectModuleError(PostService.update(MISSING_ID, { title: 'Nothing' }, author), 404, 'POST_NOT_FOUND')
    await expectModuleError(PostService.remove(MISSING_ID, { id: other.id, role: 'admin' }), 404, 'POST_NOT_FOUND')
  })

  test('deleting twice: the second is POST_NOT_FOUND', async () => {
    const created = await create()

    await PostService.remove(created.id, author)
    await expectModuleError(PostService.remove(created.id, author), 404, 'POST_NOT_FOUND')
  })
})
