import { createFileRoute } from '@tanstack/react-router'
import { requirePermission, SessionCheckError } from '@/features/auth'
import { PostEditPage, postQueryOptions } from '@/features/posts'

// Editing needs `posts:write` on top of the layout's `posts:read`. Ownership needs the post, so the page checks it.
export const Route = createFileRoute('/_authed/posts/$postId/edit')({
  beforeLoad: ({ context }) => requirePermission(context.queryClient, context.session, 'posts:write'),
  errorComponent: SessionCheckError,
  loader: ({ context, params }) => context.queryClient.prefetchQuery(postQueryOptions(params.postId)),
  head: () => ({ meta: [{ title: 'Edit post' }] }),
  component: PostEditPage,
})
