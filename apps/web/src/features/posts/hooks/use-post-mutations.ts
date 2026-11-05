import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { permissionsQueryOptions, sessionQueryOptions, useSession } from '@/features/auth'
import { api } from '@/lib/api'
import { ApiError, unwrap } from '@/lib/api-error'
import { postsKeys } from '../lib/keys'
import type { CreatePostInput, Post, UpdatePostInput } from '../lib/types'

function invalidateLists(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: postsKeys.lists() })
}

// What a refused write says about the cache. The pages show the error itself; this makes the next render truthful.
function useWriteFailureHandler() {
  const queryClient = useQueryClient()
  const userId = useSession().data?.user.id

  return useCallback(
    (error: unknown, postId?: string) => {
      if (!(error instanceof ApiError)) return
      // The session ended or was revoked. Re-reading it lets the session watcher send the visitor to /login.
      if (error.status === 401) void queryClient.invalidateQueries({ queryKey: sessionQueryOptions.queryKey, exact: true })
      // The UI offered something the API refused: the cached grants are stale (role changed), so ask again.
      if (error.status === 403 && userId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: permissionsQueryOptions(userId).queryKey, exact: true })
      }
      // Deleted elsewhere: the detail turns into its "not found" state and no list keeps showing it.
      if (error.status === 404 && postId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: postsKeys.detail(postId), exact: true })
        void invalidateLists(queryClient)
      }
    },
    [queryClient, userId],
  )
}

// POST /api/posts (`posts:write`). The new post is cached as its own detail, and every list page goes stale.
export function useCreatePost() {
  const queryClient = useQueryClient()
  const onWriteFailed = useWriteFailureHandler()

  return useMutation({
    mutationFn: async (input: CreatePostInput) => unwrap(await api.posts.post(input)),
    onSuccess: (post: Post) => {
      queryClient.setQueryData(postsKeys.detail(post.id), post)
      void invalidateLists(queryClient)
    },
    onError: (error) => onWriteFailed(error),
  })
}

// PATCH /api/posts/:id (`posts:write`, author or `posts:manage_all`).
export function useUpdatePost(id: string) {
  const queryClient = useQueryClient()
  const onWriteFailed = useWriteFailureHandler()

  return useMutation({
    mutationFn: async (changes: UpdatePostInput) => unwrap(await api.posts({ id: encodeURIComponent(id) }).patch(changes)),
    onSuccess: async (post: Post) => {
      // A GET still in flight may have read the post before this PATCH committed; landing after it, it would put the
      // old version back. Cancelled first, it can only have read it afterwards.
      await queryClient.cancelQueries({ queryKey: postsKeys.detail(post.id), exact: true })
      queryClient.setQueryData(postsKeys.detail(post.id), post)
      void invalidateLists(queryClient)
    },
    onError: (error) => onWriteFailed(error, id),
  })
}

export interface DeletePostOptions {
  // Leaves the deleted post's page. Awaited before its cached detail is dropped: a page still showing it would
  // otherwise fetch it again and flash "not found".
  onDeleted: () => Promise<unknown>
}

// DELETE /api/posts/:id (`posts:write`, author or `posts:manage_all`).
export function useDeletePost(id: string, { onDeleted }: DeletePostOptions) {
  const queryClient = useQueryClient()
  const onWriteFailed = useWriteFailureHandler()

  return useMutation({
    mutationFn: async () => {
      unwrap(await api.posts({ id: encodeURIComponent(id) }).delete())
    },
    onSuccess: async () => {
      void invalidateLists(queryClient)
      await onDeleted()
      queryClient.removeQueries({ queryKey: postsKeys.detail(id), exact: true })
    },
    onError: (error) => onWriteFailed(error, id),
  })
}
