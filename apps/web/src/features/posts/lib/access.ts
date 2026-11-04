import type { Permission, PermissionsState } from '@/features/auth'
import { forbiddenView, isReadRefused, postsErrorView, type PostsErrorView } from './errors'

// The ownership rule of PATCH/DELETE /api/posts/:id (API.md §3.4, DATABASE.md §7): `posts:write`, and either the
// author or `posts:manage_all`. UX only: it decides which actions are offered, the API decides what happens. `can()`
// is false while permissions load or after they fail, so this fails closed.
export function canChangePost(post: { authorId: string }, userId: string | undefined, can: (permission: Permission) => boolean): boolean {
  if (userId === undefined || !can('posts:write')) return false
  return post.authorId === userId || can('posts:manage_all')
}

// Why the posts on screen must not be shown, or null. A refused refetch wins over the copy still cached (query data
// survives a failed refetch), and so do grants that no longer include `posts:read` (the route guard only runs on
// navigation). Permissions that are loading or unavailable do not hide what the API already let this user read.
export function readDeniedView(error: unknown, access: Pick<PermissionsState, 'status' | 'can'>, action: 'list' | 'read'): PostsErrorView | null {
  if (isReadRefused(error)) return postsErrorView(error, action)
  if (access.status === 'ready' && !access.can('posts:read')) return forbiddenView(action)
  return null
}
