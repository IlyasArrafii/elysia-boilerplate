import { createFileRoute } from '@tanstack/react-router'
import { PostDetailPage, postQueryOptions, requirePostId } from '@/features/posts'

export const Route = createFileRoute('/_authed/posts/$postId/')({
  beforeLoad: ({ params }) => requirePostId(params.postId),
  // Prefetched so the server HTML already holds the post; a missing post or a failure is left to the page.
  loader: ({ context, params }) => context.queryClient.prefetchQuery(postQueryOptions(params.postId)),
  head: () => ({ meta: [{ title: 'Post' }] }),
  component: PostDetailPage,
})
