import { createFileRoute, Outlet } from '@tanstack/react-router'
import { requireSession, SessionCheckError } from '@/features/auth'

// Layout for every page that needs a session (apps/web R2). Runs during SSR on the first load, with the visitor's
// cookie forwarded, and again on each client navigation. Child routes get `context.session`.
export const Route = createFileRoute('/_authed')({
  beforeLoad: requireSession,
  errorComponent: SessionCheckError,
  component: Outlet,
})
