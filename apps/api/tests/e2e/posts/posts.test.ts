import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createLogStore, type LogStore } from '../../../src/utils/mongo'
import { createRedis, type Redis } from '../../../src/utils/redis'
import { createClient, type E2eClient } from '../helpers/client'

// Posts flows on the running stack (TESTING.md §3.2): the API with Redis and the MongoDB log sink on.
// Besides API_E2E_URL this needs the seeded super_admin (SEED_SUPER_ADMIN_EMAIL/PASSWORD, to promote an
// admin), E2E_REDIS_URL (the API's Redis, to see the cached list) and E2E_LOG_MONGO_URL (a log user
// that can `find`, e.g. log_reader, to find the request's `http.request` document).

const WEB_ORIGIN = process.env.WEB_URL || 'http://localhost:3001'
const LOG_DB = process.env.LOG_MONGO_DB || 'app_logs'
const run = crypto.randomUUID()
let count = 0

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} must be set for the posts E2E flows (see the top of this file)`)
  return value
}

// Better Auth limits sign-ups and sign-ins per client IP; each account gets its own.
function uniqueIp(): string {
  return `10.208.${Math.floor(Math.random() * 250)}.${(count % 250) + 1}`
}

function send(client: E2eClient, method: string, path: string, body?: unknown, ip?: string): Promise<Response> {
  const headers: Record<string, string> = { origin: WEB_ORIGIN }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (ip !== undefined) headers['x-forwarded-for'] = ip
  return client.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

async function signedUp(): Promise<{ client: E2eClient; id: string }> {
  count++
  const client = createClient()
  const response = await send(
    client,
    'POST',
    '/api/auth/sign-up/email',
    { email: `e2e+posts-${run}-${count}@example.test`, password: 'correct-horse-battery', name: `E2E Posts ${count}` },
    uniqueIp(),
  )
  expect(response.status).toBe(200)
  const { user } = (await response.json()) as { user: { id: string } }
  return { client, id: user.id }
}

interface PostBody {
  id: string
  authorId: string
  title: string
  slug: string
  status: string
}

let redis: Redis
let logStore: LogStore

// The key a list page is cached under while the current list generation lasts (posts/service.ts).
async function pageKey(page: number, limit: number): Promise<string> {
  const stored = await redis.command((client) => client.get('posts:generation:list'))
  if (stored === null) throw new Error('no posts list generation in Redis')
  return `posts:list:${JSON.parse(stored) as string}:${page}:${limit}`
}

async function signedInSuperAdmin(): Promise<E2eClient> {
  const superAdmin = createClient()
  const signIn = await send(
    superAdmin,
    'POST',
    '/api/auth/sign-in/email',
    { email: required('SEED_SUPER_ADMIN_EMAIL'), password: required('SEED_SUPER_ADMIN_PASSWORD') },
    uniqueIp(),
  )
  expect(signIn.status).toBe(200)
  return superAdmin
}
let author: { client: E2eClient; id: string }
let other: { client: E2eClient; id: string }

beforeAll(async () => {
  redis = createRedis(required('E2E_REDIS_URL'))
  logStore = createLogStore({ url: required('E2E_LOG_MONGO_URL'), dbName: LOG_DB, appName: 'posts-e2e' })
  author = await signedUp()
  other = await signedUp()
})
afterAll(async () => {
  redis?.close()
  await logStore?.close()
})

describe('posts on the running stack', () => {
  test('a user creates, lists (cache hit after the first call), edits and deletes their own post', async () => {
    const created = await send(author.client, 'POST', '/api/posts', {
      title: `E2E post ${run}`,
      content: 'Written end to end.',
    })
    expect(created.status).toBe(201)
    const post = (await created.json()) as PostBody
    expect(post).toMatchObject({ authorId: author.id, status: 'draft' })

    const limit = 17
    // A new generation, so the first read is a miss.
    await redis.command((client) => client.del('posts:generation:list'))
    const miss = await send(author.client, 'GET', `/api/posts?page=1&limit=${limit}`)
    expect(miss.status).toBe(200)
    const missBody = await miss.text()
    const cachedKey = await pageKey(1, limit)
    expect(await redis.command((client) => client.get(cachedKey))).toBe(missBody)
    const hit = await send(other.client, 'GET', `/api/posts?page=1&limit=${limit}`)
    expect(await hit.text()).toBe(missBody)

    const edited = await send(author.client, 'PATCH', `/api/posts/${post.id}`, { title: `E2E edited ${run}`, status: 'published' })
    expect(edited.status).toBe(200)
    expect(await edited.json()).toMatchObject({ id: post.id, title: `E2E edited ${run}`, status: 'published', slug: post.slug })
    // The write replaced the generation and cleared the cached pages.
    expect(await redis.command((client) => client.get(cachedKey))).toBeNull()
    expect(await pageKey(1, limit)).not.toBe(cachedKey)

    const deleted = await send(author.client, 'DELETE', `/api/posts/${post.id}`)
    expect(deleted.status).toBe(204)
    expect((await send(author.client, 'GET', `/api/posts/${post.id}`)).status).toBe(404)
  })

  test('another user gets 403 on edit and delete; a guest gets 401', async () => {
    const post = (await (await send(author.client, 'POST', '/api/posts', { title: `E2E mine ${run}`, content: 'Not yours to change.' })).json()) as PostBody

    const edit = await send(other.client, 'PATCH', `/api/posts/${post.id}`, { title: 'Taken over' })
    expect(edit.status).toBe(403)
    expect(await edit.json()).toMatchObject({ code: 'FORBIDDEN' })
    expect((await send(other.client, 'DELETE', `/api/posts/${post.id}`)).status).toBe(403)
    expect((await send(createClient(), 'GET', '/api/posts')).status).toBe(401)
  })

  test('an admin edits and deletes anyone’s post', async () => {
    const superAdmin = await signedInSuperAdmin()
    const admin = await signedUp()
    expect((await send(superAdmin, 'POST', '/api/auth/admin/set-role', { userId: admin.id, role: 'admin' })).status).toBe(200)
    const post = (await (await send(author.client, 'POST', '/api/posts', { title: `E2E for admin ${run}`, content: 'An admin may change this.' })).json()) as PostBody

    const edit = await send(admin.client, 'PATCH', `/api/posts/${post.id}`, { content: 'Changed by an admin.' })
    expect(edit.status).toBe(200)
    expect(await edit.json()).toMatchObject({ authorId: author.id })
    expect((await send(admin.client, 'DELETE', `/api/posts/${post.id}`)).status).toBe(204)
  })

  test('a removed user’s posts leave the cached list at once', async () => {
    const superAdmin = await signedInSuperAdmin()
    const leaving = await signedUp()
    const theirs = (await (await send(leaving.client, 'POST', '/api/posts', { title: `E2E leaving ${run}`, content: 'Gone with the author.' })).json()) as PostBody
    const warm = (await (await send(other.client, 'GET', '/api/posts?page=1&limit=100')).json()) as { items: PostBody[] }
    expect(warm.items.map((item) => item.id)).toContain(theirs.id)

    expect((await send(superAdmin, 'POST', '/api/auth/admin/remove-user', { userId: leaving.id })).status).toBe(200)

    const after = (await (await send(other.client, 'GET', '/api/posts?page=1&limit=100')).json()) as { items: PostBody[] }
    expect(after.items.map((item) => item.id)).not.toContain(theirs.id)
  })

  test('the x-request-id of a posts request finds its http.request document in MongoDB, with module posts', async () => {
    const response = await send(author.client, 'GET', '/api/posts?page=1&limit=5')
    const requestId = response.headers.get('x-request-id')
    expect(requestId).toBeString()

    // The sink writes in batches after the response; give it a few seconds.
    let document: Record<string, unknown> | null = null
    for (let attempt = 0; attempt < 50 && document === null; attempt++) {
      document = await logStore.collection.findOne({ event: 'http.request', requestId })
      if (document === null) await Bun.sleep(100)
    }

    expect(document).toMatchObject({ event: 'http.request', requestId, module: 'posts', route: '/api/posts', status: 200, userId: author.id })
  })
})
