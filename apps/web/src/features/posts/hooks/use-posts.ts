import { queryOptions, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { unwrap } from '@/lib/api-error'
import { postsKeys } from '../lib/keys'
import { POSTS_PAGE_SIZE } from '../lib/search'

// GET /api/posts (`posts:read`): one page, newest first. Shared by the route loader (SSR) and the page.
export function postsListQueryOptions(page: number) {
  return queryOptions({
    queryKey: postsKeys.list(page, POSTS_PAGE_SIZE),
    queryFn: () => unwrap(api.posts.get({ query: { page, limit: POSTS_PAGE_SIZE } })),
  })
}

// GET /api/posts/:id (`posts:read`). Eden puts a path param into the URL as is, so every `:id` call encodes it: an id
// is one path segment, never a path (the routes also refuse a non-UUID id, see `lib/post-id.ts`).
export function postQueryOptions(id: string) {
  return queryOptions({
    queryKey: postsKeys.detail(id),
    queryFn: () => unwrap(api.posts({ id: encodeURIComponent(id) }).get()),
  })
}

// A read refused with 401 or 403 re-reads the session or the grants app-wide (`installAuthFailureReactions`).
export function usePostsList(page: number) {
  return useQuery(postsListQueryOptions(page))
}

export function usePost(id: string) {
  return useQuery(postQueryOptions(id))
}
