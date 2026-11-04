import { createFileRoute } from '@tanstack/react-router'
import { AccessPage, permissionsQueryOptions } from '@/features/auth'

export const Route = createFileRoute('/_authed/access')({
  // Prefetched so the server HTML already lists the permissions; a failure leaves the page's own error state.
  loader: ({ context }) => context.queryClient.prefetchQuery(permissionsQueryOptions(context.session.user.id)),
  head: () => ({ meta: [{ title: 'Your access' }] }),
  component: AccessPage,
})
