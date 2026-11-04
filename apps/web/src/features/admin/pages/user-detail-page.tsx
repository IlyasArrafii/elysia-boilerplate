import { Button, cn } from '@repo/ui'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { Fragment } from 'react'
import { usePermissions, useSession } from '@/features/auth'
import { ApiError } from '@/lib/api-error'
import { AccessFallback, AdminAlert } from '../components/admin-alert'
import { useAdminScreens } from '../components/admin-nav'
import { BanPanel } from '../components/ban-panel'
import { RolePanel } from '../components/role-panel'
import { SessionsPanel } from '../components/sessions-panel'
import { UserStatus } from '../components/user-status'
import { useForbiddenRefresh } from '../hooks/use-forbidden-refresh'
import { useUser } from '../hooks/use-users'
import { adminErrorView, USER_NOT_FOUND } from '../lib/errors'
import { formatDateTime } from '../lib/users'

const BACK_LINK = cn(
  'inline-flex min-h-11 items-center rounded-sm text-accent underline-offset-2 hover:underline lg:hidden',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
)

// /admin/users/$userId: the detail beside the list (DESIGN.md §6); a page of its own on narrow screens. Rendered only
// once `user:list` and `user:get` are confirmed.
export function UserDetailPage() {
  const { userId } = useParams({ from: '/_authed/admin/users/$userId' })
  const search = useSearch({ from: '/_authed/admin/users/$userId' })
  const session = useSession()
  const access = usePermissions()
  const allowed = useAdminScreens().user
  const user = useUser(userId, allowed)
  useForbiddenRefresh(user.error)
  const currentUserId = session.data?.user.id ?? ''

  if (!allowed) {
    return (
      <article aria-labelledby="user-heading" className="grid gap-4">
        <h2 id="user-heading" className="text-h2">
          User <span className="font-mono text-mono break-all">{userId}</span>
        </h2>
        <AccessFallback status={access.status}>Your role no longer allows user details.</AccessFallback>
      </article>
    )
  }

  return (
    <article aria-labelledby="user-heading" className="grid gap-4">
      <Link to="/admin/users" search={search} className={BACK_LINK}>
        ← Back to users
      </Link>

      {user.isPending && (
        <div aria-busy="true" aria-label="Loading user" className="grid gap-2">
          <div className="h-8 w-2/3 animate-pulse bg-hover" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="h-11 animate-pulse bg-hover" />
          ))}
        </div>
      )}

      {user.isError && !user.data && (
        <>
          <h2 id="user-heading" className="text-h2">
            User <span className="font-mono text-mono break-all">{userId}</span>
          </h2>
          <AdminAlert error={adminErrorView(user.error, 'user')}>
            {!(user.error instanceof ApiError && user.error.code === USER_NOT_FOUND) && (
              <Button onClick={() => void user.refetch()}>Try again</Button>
            )}
          </AdminAlert>
        </>
      )}

      {user.data && (
        <>
          <header className="grid gap-1">
            <h2 id="user-heading" className="text-h2 break-words">
              {user.data.name}
              {user.data.id === currentUserId && <span className="text-caption text-muted"> (you)</span>}
            </h2>
            <p className="break-all">{user.data.email}</p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted">User ID</dt>
              <dd className="font-mono text-mono break-all">{user.data.id}</dd>
              <dt className="text-muted">Status</dt>
              <dd>
                <UserStatus user={user.data} />
              </dd>
              <dt className="text-muted">Created</dt>
              <dd className="font-mono text-mono">{formatDateTime(user.data.createdAt)}</dd>
            </dl>
          </header>
          {user.isError && (
            <AdminAlert error={adminErrorView(user.error, 'user')}>
              <Button onClick={() => void user.refetch()}>Try again</Button>
            </AdminAlert>
          )}
          {/* Keyed by the user: the route keeps this component across `$userId` changes, and a notice, picked role or open
              confirmation for one user must never be shown for the next. Refetches of the same user keep them. */}
          <Fragment key={user.data.id}>
            <RolePanel user={user.data} currentUserId={currentUserId} />
            <BanPanel user={user.data} currentUserId={currentUserId} />
            <SessionsPanel userId={user.data.id} isSelf={user.data.id === currentUserId} />
          </Fragment>
        </>
      )}
    </article>
  )
}
