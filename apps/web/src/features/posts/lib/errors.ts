import type { ErrorView } from '@/components/error-alert'
import { ApiError, NETWORK_ERROR } from '@/lib/api-error'

export type PostsAction = 'list' | 'read' | 'create' | 'update' | 'delete'

const FORBIDDEN: Record<PostsAction, string> = {
  list: 'Your role does not allow reading posts.',
  read: 'Your role does not allow reading posts.',
  create: 'Your role does not allow creating posts.',
  update: 'You can change only your own posts, unless your role allows managing all posts.',
  delete: 'You can delete only your own posts, unless your role allows managing all posts.',
}

const FALLBACK: Record<PostsAction, string> = {
  list: 'The posts could not be loaded. Try again.',
  read: 'This post could not be loaded. Try again.',
  create: 'The post could not be created. Try again.',
  update: 'The post could not be saved. Try again.',
  delete: 'The post could not be deleted. Try again.',
}

// What the API would answer, shown without asking it when the UI already knows (someone else's post, no
// `posts:manage_all`). The code is the API's own (API.md §1).
export function forbiddenView(action: PostsAction): ErrorView {
  return { code: 'FORBIDDEN', message: FORBIDDEN[action] }
}

// The API answered that the post is not there: 404 POST_NOT_FOUND, or a 400 on `/id` because the address does not
// hold a post id at all (API.md §3.4).
export function isMissingPost(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false
  return error.status === 404 || (error.status === 400 && error.code === 'VALIDATION_ERROR')
}

// The API refused the read itself: no session (401) or no `posts:read` (403).
export function isReadRefused(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403)
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403
}

// `usePermissions().error`: the ApiError of GET /api/me/permissions or of the session check before it, or something
// else that failed.
export function permissionsErrorView(error: unknown): ErrorView {
  const code = error instanceof ApiError ? error.code : NETWORK_ERROR
  return { code, message: 'Your permissions could not be loaded, so writing posts is unavailable for now.' }
}

// DESIGN.md §11: the code in monospace and a message. Messages are written here, never taken from the response.
export function postsErrorView(error: unknown, action: PostsAction): ErrorView {
  if (!(error instanceof ApiError) || error.network) {
    return { code: NETWORK_ERROR, message: 'The API could not be reached. Check your connection and try again.' }
  }
  if (error.status === 401) return { code: error.code, message: 'Your session has ended. Sign in again to continue.' }
  if (error.status === 403) return { ...forbiddenView(action), code: error.code }
  if (error.status === 404) return { code: error.code, message: 'This post no longer exists. It may have been deleted.' }
  if (error.status === 400 && (action === 'create' || action === 'update')) {
    return { code: error.code, message: 'The server did not accept the post. Check the fields below.' }
  }
  return { code: error.code, message: FALLBACK[action] }
}
