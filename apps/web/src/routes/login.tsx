import { createFileRoute } from '@tanstack/react-router'
import { LoginPage, redirectSignedIn, validateLoginSearch } from '@/features/auth'

export const Route = createFileRoute('/login')({
  validateSearch: validateLoginSearch,
  // A signed-in visitor goes to `?redirect=` (checked to stay on this origin) or `/`.
  beforeLoad: redirectSignedIn,
  head: () => ({ meta: [{ title: 'Sign in' }] }),
  component: LoginPage,
})
