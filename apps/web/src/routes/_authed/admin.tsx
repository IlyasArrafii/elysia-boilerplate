import { createFileRoute } from '@tanstack/react-router'
import { AdminLayout } from '@/features/admin'

// Layout of every /admin screen. Each screen checks its own permissions in `beforeLoad` (static-roles.md §6).
export const Route = createFileRoute('/_authed/admin')({
  component: AdminLayout,
})
