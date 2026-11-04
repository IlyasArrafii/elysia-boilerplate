import { createFileRoute } from '@tanstack/react-router'
import { RegisterPage, redirectSignedIn, validateLoginSearch } from '@/features/auth'

export const Route = createFileRoute('/register')({
  validateSearch: validateLoginSearch,
  beforeLoad: redirectSignedIn,
  head: () => ({ meta: [{ title: 'Create an account' }] }),
  component: RegisterPage,
})
