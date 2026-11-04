import { mock } from 'bun:test'

// Stand-ins for both API clients, registered once: every posts test file imports this module first and loads the
// app or the feature afterwards with `await import()` (Bun links static imports before `mock.module` runs).

type Result<Data> = { data: Data; error: null } | { data: null; error: { status: number; value: unknown } }
type ClientResult<Data> = { data: Data; error: null } | { data: null; error: { status: number; statusText: string; code?: string } }

export interface PostData {
  id: string
  authorId: string
  title: string
  slug: string
  content: string
  status: 'draft' | 'published'
  createdAt: string
  updatedAt: string
}

export interface ListData {
  items: PostData[]
  meta: { page: number; limit: number; total: number; totalPages: number }
}

export interface PostBody {
  title?: string
  content?: string
  status?: 'draft' | 'published'
}

export type RawSession = { user: { id: string; email: string; name: string; image: string | null }; session: { id: string; token: string; userId: string } }
export type PermissionsBody = { roles: string[]; permissions: string[] }

export const getSession = mock<() => Promise<ClientResult<RawSession | null>>>()
export const signOut = mock<() => Promise<ClientResult<unknown>>>()

mock.module('@/lib/auth-client', () => ({
  authClient: { getSession, signOut, signIn: { email: mock(), social: mock() }, signUp: { email: mock() } },
}))

export const permissionsGet = mock<() => Promise<Result<PermissionsBody>>>()
export const listPosts = mock<(call: { query: { page: number; limit: number } }) => Promise<Result<ListData>>>()
export const createPost = mock<(body: PostBody) => Promise<Result<PostData>>>()
export const getPost = mock<(id: string) => Promise<Result<PostData>>>()
export const patchPost = mock<(id: string, body: PostBody) => Promise<Result<PostData>>>()
export const deletePost = mock<(id: string) => Promise<Result<undefined>>>()

// Eden's shape: `api.posts.get()`, `api.posts.post(body)`, `api.posts({ id }).get() / .patch(body) / .delete()`.
const posts = Object.assign(
  ({ id }: { id: string }) => ({
    get: () => getPost(id),
    patch: (body: PostBody) => patchPost(id, body),
    delete: () => deletePost(id),
  }),
  { get: listPosts, post: createPost },
)

// `health` answers too, because the real route tree mounts the status page at `/`.
const healthGet = async () => ({ data: { status: 'ok', db: 'up', redis: 'up', logStore: 'up', uptime: 1 }, error: null })

mock.module('@/lib/api', () => ({ api: { me: { permissions: { get: permissionsGet } }, health: { get: healthGet }, posts } }))

export const ok = <Data>(data: Data) => ({ data, error: null })
export const apiFailed = (status: number, value: unknown) => ({ data: null, error: { status, value } })
export const validationFailed = (...fields: { path: string; rule: string }[]) =>
  apiFailed(400, { code: 'VALIDATION_ERROR', message: 'Invalid request', details: { fields } })
export const notFound = () => apiFailed(404, { code: 'POST_NOT_FOUND', message: 'Post not found' })
export const forbidden = () => apiFailed(403, { code: 'FORBIDDEN', message: 'Forbidden' })

export const ALICE: RawSession = {
  user: { id: 'usr_alice', email: 'alice@example.test', name: 'Alice', image: null },
  session: { id: 'ses_alice', token: 'secret-token-alice', userId: 'usr_alice' },
}

export const USER_ACCESS: PermissionsBody = { roles: ['user'], permissions: ['posts:read', 'posts:write'] }
export const ADMIN_ACCESS: PermissionsBody = { roles: ['admin'], permissions: ['posts:read', 'posts:write', 'posts:manage_all'] }
export const READ_ONLY_ACCESS: PermissionsBody = { roles: ['reader'], permissions: ['posts:read'] }
export const NO_ACCESS: PermissionsBody = { roles: ['retired_role'], permissions: [] }

export const OWN_POST: PostData = {
  id: '0b5c1f8e-1a2b-4c3d-8e9f-000000000001',
  authorId: 'usr_alice',
  title: 'Alice writes',
  slug: 'alice-writes',
  content: 'The first post by Alice.',
  status: 'published',
  createdAt: '2026-11-03T09:15:00.000Z',
  updatedAt: '2026-11-03T09:15:00.000Z',
}

export const OTHER_POST: PostData = {
  id: '0b5c1f8e-1a2b-4c3d-8e9f-000000000002',
  authorId: 'usr_bob',
  title: 'Bob drafts',
  slug: 'bob-drafts',
  content: 'A draft that Bob wrote.',
  status: 'draft',
  createdAt: '2026-11-02T08:00:00.000Z',
  updatedAt: '2026-11-02T08:00:00.000Z',
}

export function listOf(items: PostData[], meta: Partial<ListData['meta']> = {}): ListData {
  const total = meta.total ?? items.length
  const limit = meta.limit ?? 20
  return { items, meta: { page: 1, limit, total, totalPages: Math.ceil(total / limit), ...meta } }
}

export function resetPostsMocks() {
  for (const fn of [getSession, signOut, permissionsGet, listPosts, createPost, getPost, patchPost, deletePost]) fn.mockReset()
}
