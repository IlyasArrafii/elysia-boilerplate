import { createFileRoute } from '@tanstack/react-router'
import { requireScreen, UsersPage, usersQueryOptions, validateUsersSearch } from '@/features/admin'

export const Route = createFileRoute('/_authed/admin/users')({
  validateSearch: validateUsersSearch,
  beforeLoad: ({ context }) => requireScreen(context.queryClient, context.session, 'users'),
  loaderDeps: ({ search }) => search,
  // Prefetched so the server HTML already lists the users; a failure leaves the page's own error state.
  loader: ({ context, deps }) => context.queryClient.prefetchQuery(usersQueryOptions(deps)),
  head: () => ({ meta: [{ title: 'Users' }] }),
  component: UsersPage,
})
