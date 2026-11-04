import { Type } from '@sinclair/typebox'
import { t } from 'elysia'
import { readPostsLimits } from '../../env'

// API.md §3.4. The minimums are the contract; the maximums are product numbers set per deployment
// (POSTS_TITLE_MAX_LENGTH, POSTS_CONTENT_MAX_LENGTH), required at startup (TASK-08).
const TITLE_MIN_LENGTH = 3
const CONTENT_MIN_LENGTH = 10
const { titleMaxLength, contentMaxLength } = readPostsLimits()

if (titleMaxLength < TITLE_MIN_LENGTH) {
  throw new Error(`POSTS_TITLE_MAX_LENGTH must be at least ${TITLE_MIN_LENGTH}, got ${titleMaxLength}`)
}
if (contentMaxLength < CONTENT_MIN_LENGTH) {
  throw new Error(`POSTS_CONTENT_MAX_LENGTH must be at least ${CONTENT_MIN_LENGTH}, got ${contentMaxLength}`)
}

// API.md §2: `limit` at most 100. `page` is bounded too (apps/api R18), so OFFSET never walks more
// than a million rows (TASK-08).
const MAX_LIMIT = 100
const MAX_PAGE = 10_000

// Not `t.UnionEnum`: Elysia 1.4.30 gives it its first value as a default, which would fill `status:
// 'draft'` into every PATCH that leaves it out. A missing status on create is the column default.
const status = t.Union([t.Literal('draft'), t.Literal('published')])

const createBody = {
  title: t.String({ minLength: TITLE_MIN_LENGTH, maxLength: titleMaxLength }),
  content: t.String({ minLength: CONTENT_MIN_LENGTH, maxLength: contentMaxLength }),
}

const post = t.Object({
  id: t.String({ format: 'uuid' }),
  authorId: t.String(),
  title: t.String(),
  slug: t.String(),
  content: t.String(),
  status,
  // ISO 8601 strings on every path, so a cached list is byte for byte the one read from PostgreSQL.
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
})

export const PostModel = {
  post,

  list: t.Object({
    items: t.Array(post),
    meta: t.Object({
      page: t.Integer(),
      limit: t.Integer(),
      total: t.Integer(),
      totalPages: t.Integer(),
    }),
  }),

  // Elysia 1.4.30 coerces query numbers through its `Numeric` decode, which checks a range on the bare
  // number and reports it with an empty path. So the route schema only coerces, and `listRange` (plain
  // TypeBox: Elysia's `t.Integer` is a string-or-number union) checks the coerced query, giving
  // `/limit` + `maximum` like any other field (TASK-08).
  listQuery: t.Object({
    page: t.Integer({ default: 1 }),
    limit: t.Integer({ default: 20 }),
  }),

  listRange: Type.Object({
    page: Type.Integer({ minimum: 1, maximum: MAX_PAGE }),
    limit: Type.Integer({ minimum: 1, maximum: MAX_LIMIT }),
  }),

  params: t.Object({ id: t.String({ format: 'uuid' }) }),

  // Fields outside the schema (`slug`, `authorId`, …) are dropped before validation (Elysia's
  // `normalize`), so they can never be written.
  create: t.Object({ ...createBody, status: t.Optional(status) }),

  // Any subset of the create body, but not an empty one (TASK-08).
  update: t.Object(
    { title: t.Optional(createBody.title), content: t.Optional(createBody.content), status: t.Optional(status) },
    { minProperties: 1 },
  ),
}

export type Post = typeof PostModel.post.static
export type PostList = typeof PostModel.list.static
export type CreatePost = typeof PostModel.create.static
export type UpdatePost = typeof PostModel.update.static
