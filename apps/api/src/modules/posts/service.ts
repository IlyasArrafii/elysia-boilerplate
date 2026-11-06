import { post } from '@repo/db'
import { count, desc, eq } from 'drizzle-orm'
import { env } from '../../env'
import { FORBIDDEN, hasPermission, onUserRemoved } from '../../utils/auth'
import { moduleCache } from '../../utils/cache'
import { db } from '../../utils/db'
import { moduleError } from '../../utils/error'
import { LIST_DEFAULT_LIMIT, type CreatePost, type Post, type PostList, type UpdatePost } from './model'

const MODULE = 'posts'
// Pages are `posts:list:{generation}:{page}:{limit}` (API.md §3.4). The generation is a random token
// under `posts:generation:list`, read before the page is loaded from the database. A write deletes
// it once committed, and the next read starts a new one, so a load that started before the write
// can only store its page under the old token, which no later read asks for; with several API
// instances too, since the token is in Redis. The write also removes the old pages with SCAN (R38);
// they would otherwise wait out the TTL.
const LIST_KEYS = 'list:*'
const GENERATION_KEY = 'generation:list'
const postsCache = moduleCache(MODULE, { ttlSeconds: env.POSTS_CACHE_TTL })
// Every cached page size holds its own copy of every post, so only these are cached; any other
// `limit` reads PostgreSQL. Add a size here when a client offers it as a choice.
const CACHED_LIST_LIMITS: ReadonlySet<number> = new Set([LIST_DEFAULT_LIMIT])

// Shares the module TTL. A missing token (deleted by a write, expired, or never set) is replaced by a
// new one before the load, so the same rule holds: whatever is stored under a token was read after
// the token was set. With Redis down every read misses, so each list is a fresh token whose page is
// never stored: the list comes from PostgreSQL.
async function listGeneration(): Promise<string> {
  const current = await postsCache.get<string>(GENERATION_KEY)
  if (current !== undefined) return current
  const fresh = crypto.randomUUID()
  await postsCache.set(GENERATION_KEY, fresh)
  return fresh
}

// After every committed write to posts, including the rows a user removal deletes by cascade. Both
// calls are invalidations: they reach Redis even while the module's breaker is open, and never throw,
// because the write is already committed and a 500 would make the client retry a POST that
// succeeded, creating the post twice. A failure is reported as `cache.unavailable`. If the generation
// delete was not confirmed (a timeout may still have applied it), cached pages may miss the write
// until they expire, at most `POSTS_CACHE_TTL` seconds; if only the page sweep failed, no read asks
// for the old pages and they expire alone.
// Sent together: only the generation's deletion decides what later reads see, so their order does
// not matter, and on a Redis that has stopped answering a write waits out one reply deadline, not two.
async function invalidateLists(): Promise<void> {
  await Promise.all([postsCache.del(GENERATION_KEY), postsCache.delPattern(LIST_KEYS)])
}

// Long enough to read, short enough for the unique index whatever the title limit is.
const SLUG_MAX_LENGTH = 64
const SLUG_FALLBACK = 'post'
const SLUG_SUFFIX_LENGTH = 6
// A collision on the base slug takes a random suffix; five clashes in a row is not bad luck.
const SLUG_ATTEMPTS = 5

// The caller, as the controller got it from the `permission` option.
export interface Actor {
  id: string
  role: string | null | undefined
}

type PostRow = typeof post.$inferSelect

function toPost(row: PostRow): Post {
  return {
    id: row.id,
    authorId: row.authorId,
    title: row.title,
    slug: row.slug,
    content: row.content,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// "Héllo, World!" → "hello-world". Accents are folded; anything else that is not a-z or 0-9 is a
// separator, and a title with nothing left becomes "post".
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, '')
  return slug === '' ? SLUG_FALLBACK : slug
}

function slugSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_SUFFIX_LENGTH))
  return Array.from(bytes, (byte) => (byte % 36).toString(36)).join('')
}

const notFound = () => moduleError(MODULE, 404, 'POST_NOT_FOUND', 'Post not found')
const forbidden = () => moduleError(MODULE, 403, FORBIDDEN.code, FORBIDDEN.message)

export abstract class PostService {
  // Newest first. Only the page sizes in CACHED_LIST_LIMITS are cached, and a page past the end is
  // an empty page that is not cached, so neither odd limits nor high page numbers can fill the cache.
  static async list(page: number, limit: number): Promise<PostList> {
    if (!CACHED_LIST_LIMITS.has(limit)) return PostService.load(page, limit)

    const key = `list:${await listGeneration()}:${page}:${limit}`
    const cached = await postsCache.get<PostList>(key)
    if (cached !== undefined) return cached

    const list = await PostService.load(page, limit)
    if (page <= Math.max(list.meta.totalPages, 1)) await postsCache.set(key, list)
    return list
  }

  private static async load(page: number, limit: number): Promise<PostList> {
    const [rows, [totals]] = await Promise.all([
      db
        .select()
        .from(post)
        .orderBy(desc(post.createdAt), desc(post.id))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ total: count() }).from(post),
    ])
    const total = totals?.total ?? 0
    const totalPages = Math.ceil(total / limit)
    return { items: rows.map(toPost), meta: { page, limit, total, totalPages } }
  }

  static async get(id: string): Promise<Post> {
    const [row] = await db.select().from(post).where(eq(post.id, id))
    if (row === undefined) throw notFound()
    return toPost(row)
  }

  static async create(authorId: string, input: CreatePost): Promise<Post> {
    const base = slugify(input.title)
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${slugSuffix()}`
      const [row] = await db
        .insert(post)
        .values({ authorId, title: input.title, content: input.content, status: input.status, slug })
        .onConflictDoNothing({ target: post.slug })
        .returning()
      if (row !== undefined) {
        await invalidateLists()
        return toPost(row)
      }
    }
    throw new Error(`No free slug for "${base}" after ${SLUG_ATTEMPTS} attempts`)
  }

  // The slug stays as created, so links keep working after a title change.
  static async update(id: string, input: UpdatePost, actor: Actor): Promise<Post> {
    await PostService.assertMayChange(id, actor)
    const [row] = await db
      .update(post)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(post.id, id))
      .returning()
    // Deleted between the check and the update.
    if (row === undefined) throw notFound()
    await invalidateLists()
    return toPost(row)
  }

  static async remove(id: string, actor: Actor): Promise<void> {
    await PostService.assertMayChange(id, actor)
    const [row] = await db.delete(post).where(eq(post.id, id)).returning({ id: post.id })
    if (row === undefined) throw notFound()
    await invalidateLists()
  }

  // The ownership rule (DATABASE.md §7): the author, or a holder of `posts:manage_all`. A missing
  // post is 404 before anything else; the author never changes, so the check cannot go stale.
  private static async assertMayChange(id: string, actor: Actor): Promise<void> {
    const [row] = await db.select({ authorId: post.authorId }).from(post).where(eq(post.id, id))
    if (row === undefined) throw notFound()
    if (row.authorId === actor.id) return
    if (!(await hasPermission(actor.role, 'posts:manage_all'))) throw forbidden()
  }
}

// A removed user's posts go with them (`ON DELETE CASCADE`), past this service.
onUserRemoved(invalidateLists)
