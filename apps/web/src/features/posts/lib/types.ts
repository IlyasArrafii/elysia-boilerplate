import type { api } from '@/lib/api'

// Derived from the Eden client, so they follow the API's schemas (apps/web R8: no hand-written response types).
type PostCall = ReturnType<typeof api.posts>

export type Post = NonNullable<Awaited<ReturnType<PostCall['get']>>['data']>
export type PostList = NonNullable<Awaited<ReturnType<typeof api.posts.get>>['data']>
export type PostStatus = Post['status']
export type CreatePostInput = Parameters<typeof api.posts.post>[0]
export type UpdatePostInput = Parameters<PostCall['patch']>[0]
