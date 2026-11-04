import { createFileRoute } from '@tanstack/react-router'
import { pageOf, PostsListPage, postsListQueryOptions, validatePostsSearch } from '@/features/posts'

export const Route = createFileRoute('/_authed/posts/')({
  validateSearch: validatePostsSearch,
  loaderDeps: ({ search }) => ({ page: pageOf(search) }),
  // Prefetched so the server HTML already holds the page; a failure is left to the page's own error state.
  loader: ({ context, deps }) => context.queryClient.prefetchQuery(postsListQueryOptions(deps.page)),
  head: () => ({ meta: [{ title: 'Posts' }] }),
  component: PostsListPage,
})
