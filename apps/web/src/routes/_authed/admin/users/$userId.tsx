import { createFileRoute } from '@tanstack/react-router'
import { requireScreen, UserDetailPage, userQueryOptions } from '@/features/admin'

export const Route = createFileRoute('/_authed/admin/users/$userId')({
  beforeLoad: ({ context }) => requireScreen(context.queryClient, context.session, 'user'),
  // The user only: their sessions hold tokens and are fetched in the browser (features/admin).
  loader: ({ context, params }) => context.queryClient.prefetchQuery(userQueryOptions(params.userId)),
  head: () => ({ meta: [{ title: 'User' }] }),
  component: UserDetailPage,
})
