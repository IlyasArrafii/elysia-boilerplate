import { createFileRoute } from '@tanstack/react-router'
import { requireScreen, RolesPage, rolesQueryOptions } from '@/features/admin'

export const Route = createFileRoute('/_authed/admin/roles')({
  beforeLoad: ({ context }) => requireScreen(context.queryClient, context.session, 'roles'),
  loader: ({ context }) => context.queryClient.prefetchQuery(rolesQueryOptions),
  head: () => ({ meta: [{ title: 'Roles' }] }),
  component: RolesPage,
})
