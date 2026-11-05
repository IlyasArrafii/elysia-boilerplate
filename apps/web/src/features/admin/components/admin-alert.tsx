import type { ReactNode } from 'react'
import type { PermissionsState } from '@/features/auth'

// A change the API confirmed. Shown only after the request succeeded, never optimistically.
export function AdminSuccess({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p role="status" className="border border-success px-4 py-3">
      <span className="font-mono text-mono text-success">
        <span aria-hidden="true">✓ </span>DONE
      </span>
      <span className="ml-3">{children}</span>
    </p>
  )
}

// A section the signed-in user's role does not open (DESIGN.md §11, forbidden state).
export function ForbiddenNote({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p className="border border-warning px-4 py-3">
      <span className="font-mono text-mono text-warning">FORBIDDEN</span>
      <span className="ml-3">{children}</span>
    </p>
  )
}

// What a screen shows instead of its data when the grants it needs are not established. Only a confirmed answer
// (`ready`) says forbidden; while loading a placeholder holds the space, and when the permissions cannot be loaded
// nothing is shown here (the admin layout explains and offers a retry). Cached data is never shown in its place.
export function AccessFallback({ status, children }: Readonly<{ status: PermissionsState['status']; children: ReactNode }>) {
  if (status === 'ready') return <ForbiddenNote>{children}</ForbiddenNote>
  if (status === 'loading') return <div aria-busy="true" aria-label="Loading permissions" className="h-11 animate-pulse bg-hover" />
  return null
}
