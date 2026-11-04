import { createFileRoute } from '@tanstack/react-router'
import { redirectToAdminHome } from '@/features/admin'

export const Route = createFileRoute('/_authed/admin/')({
  beforeLoad: ({ context }) => redirectToAdminHome(context.queryClient, context.session),
})
