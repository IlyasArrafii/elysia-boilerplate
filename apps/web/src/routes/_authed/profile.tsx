import { createFileRoute } from '@tanstack/react-router'
import { ProfilePage } from '@/features/profile'

// Needs only a session (static-roles.md §6: `profile` is `auth: true` only); `_authed` checks it.
export const Route = createFileRoute('/_authed/profile')({
  head: () => ({ meta: [{ title: 'Profile' }] }),
  component: ProfilePage,
})
