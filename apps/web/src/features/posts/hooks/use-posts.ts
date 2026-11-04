import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { permissionsQueryOptions, useSession } from '@/features/auth'
import { api } from '@/lib/api'
import { unwrap } from '@/lib/api-error'
import { isForbidden } from '../lib/errors'
import { postsKeys } from '../lib/keys'
import { POSTS_PAGE_SIZE } from '../lib/search'

// GET /api/posts (`posts:read`): one page, newest first. Shared by the route loader (SSR) and the page.
export function postsListQueryOptions(page: number) {
  return queryOptions({
    queryKey: postsKeys.list(page, POSTS_PAGE_SIZE),
    queryFn: async () => unwrap(await api.posts.get({ query: { page, limit: POSTS_PAGE_SIZE } })),
  })
}

// GET /api/posts/:id (`posts:read`).
export function postQueryOptions(id: string) {
  return queryOptions({
    queryKey: postsKeys.detail(id),
    queryFn: async () => unwrap(await api.posts({ id }).get()),
  })
}

// A read refused with 403 means the cached grants are stale (role changed): ask for them again, so the page and every
// other permission check re-evaluate. A 401 needs nothing here: the session watcher re-reads the session.
function useRefreshGrantsOnForbidden(error: unknown) {
  const queryClient = useQueryClient()
  const userId = useSession().data?.user.id

  useEffect(() => {
    if (!isForbidden(error) || userId === undefined) return
    void queryClient.invalidateQueries({ queryKey: permissionsQueryOptions(userId).queryKey, exact: true })
  }, [error, queryClient, userId])
}

export function usePostsList(page: number) {
  const query = useQuery(postsListQueryOptions(page))
  useRefreshGrantsOnForbidden(query.error)
  return query
}

export function usePost(id: string) {
  const query = useQuery(postQueryOptions(id))
  useRefreshGrantsOnForbidden(query.error)
  return query
}
