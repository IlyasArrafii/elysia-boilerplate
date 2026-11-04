import { createFileRoute, Outlet } from '@tanstack/react-router'
import { requirePermission, SessionCheckError } from '@/features/auth'

// Every posts page needs `posts:read` (static-roles.md §6). Without it the visitor goes to /?notice=forbidden; if the
// permissions cannot be loaded, the error component says so and "Try again" re-runs this guard.
export const Route = createFileRoute('/_authed/posts')({
  beforeLoad: ({ context }) => requirePermission(context.queryClient, context.session, 'posts:read'),
  errorComponent: SessionCheckError,
  component: Outlet,
})
