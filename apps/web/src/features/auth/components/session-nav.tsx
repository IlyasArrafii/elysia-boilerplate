import { Button } from '@repo/ui'
import { NavLink } from '@/components/nav-link'
import { useSignOut } from '../hooks/use-auth-actions'
import { useSession } from '../hooks/use-session'

// Links that exist for the current visitor: a guest sees nothing that needs a session (DESIGN.md §11:
// forbidden pages are not shown in navigation).
export function SessionLinks() {
  const session = useSession()
  if (!session.data) return null
  return <NavLink to="/access">Your access</NavLink>
}

// The right side of the header: who is signed in and how to leave, or how to get in.
export function SessionNav() {
  const session = useSession()
  const signOut = useSignOut()

  if (session.isPending) {
    return <span role="status" aria-label="Checking your session" className="block h-5 w-32 animate-pulse bg-hover" />
  }

  if (!session.data) {
    return (
      <div className="flex flex-wrap items-center gap-1">
        <NavLink to="/login">Sign in</NavLink>
        <NavLink to="/register">Register</NavLink>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <span className="min-w-0 truncate font-mono text-mono text-muted" title={session.data.user.email}>
        <span className="sr-only">Signed in as </span>
        {session.data.user.email}
      </span>
      <Button variant="ghost" disabled={signOut.isPending} onClick={() => signOut.mutate()}>
        {signOut.isPending ? 'Signing out…' : 'Sign out'}
      </Button>
      {signOut.isError && (
        <p role="alert" className="w-full text-right text-caption text-danger">
          Sign-out failed. You are still signed in; try again.
        </p>
      )}
    </div>
  )
}
