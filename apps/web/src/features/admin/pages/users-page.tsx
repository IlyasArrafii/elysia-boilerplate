import { Button, cn, Input } from '@repo/ui'
import { Link, Outlet, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { ErrorAlert } from '@/components/error-alert'
import { usePermissions } from '@/features/auth'
import { AccessFallback } from '../components/admin-alert'
import { useAdminScreens } from '../components/admin-nav'
import { FieldLabel } from '../components/fields'
import { UsersSkeleton, UsersTable } from '../components/users-table'
import { useUsers } from '../hooks/use-users'
import { adminErrorView } from '../lib/errors'
import type { UsersSearch } from '../lib/users'

const PAGER_LINK = cn(
  'inline-flex min-h-11 items-center rounded-sm border border-border px-4 text-fg hover:bg-hover',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
)

// /admin/users and /admin/users/$userId: master/detail (DESIGN.md §6, §10). From 1024px the list and the selected
// user sit side by side; below that they stack: the list, or the selected user with a way back. The list renders only
// once `user:list` is confirmed, so a cached page never shows while the permissions are loading or failed.
export function UsersPage() {
  const search = useSearch({ from: '/_authed/admin/users' })
  const { userId } = useParams({ strict: false })
  const screens = useAdminScreens()
  const access = usePermissions()
  const detailOpen = userId !== undefined

  if (!screens.users) {
    return (
      <section aria-labelledby="users-heading" className="mt-6">
        <h1 id="users-heading" className="text-h1 text-primary">
          Users
        </h1>
        <div className="mt-4">
          <AccessFallback status={access.status}>Your role no longer allows the user list.</AccessFallback>
        </div>
      </section>
    )
  }

  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-12 lg:gap-4">
      <section aria-labelledby="users-heading" className={cn('min-w-0', detailOpen ? 'hidden lg:col-span-5 lg:block' : 'lg:col-span-12')}>
        <h1 id="users-heading" className="text-h1 text-primary">
          Users
        </h1>
        <UsersSearchForm key={search.q ?? ''} search={search} />
        <UsersList search={search} selectedId={userId} compact={detailOpen} />
      </section>
      {detailOpen && (
        <div className="min-w-0 lg:col-span-7 lg:border-l lg:border-border lg:pl-4">
          <Outlet />
        </div>
      )}
    </div>
  )
}

function UsersSearchForm({ search }: Readonly<{ search: UsersSearch }>) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState(search.q ?? '')

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const q = draft.trim()
    void navigate({ to: '/admin/users', search: q === '' ? {} : { q } })
  }

  return (
    <form role="search" onSubmit={onSubmit} className="mt-4 flex flex-wrap items-end gap-2">
      <div className="grid min-w-0 flex-1 basis-56 gap-1.5">
        <FieldLabel htmlFor="users-search">Search by email</FieldLabel>
        <Input id="users-search" type="search" value={draft} onChange={(event) => setDraft(event.target.value)} />
      </div>
      <Button type="submit">Search</Button>
    </form>
  )
}

function UsersList({ search, selectedId, compact }: Readonly<{ search: UsersSearch; selectedId: string | undefined; compact: boolean }>) {
  const users = useUsers(search)

  if (users.isPending) return <UsersSkeleton />

  if (users.isError) {
    return (
      <div className="mt-4">
        <ErrorAlert error={adminErrorView(users.error, 'users')}>
          <Button onClick={() => void users.refetch()}>Try again</Button>
        </ErrorAlert>
      </div>
    )
  }

  const { data } = users
  if (data.users.length === 0) {
    return (
      <div className="mt-4 border-y border-border py-4">
        {search.q === undefined ? (
          <p className="text-muted">No users yet.</p>
        ) : (
          <>
            <p className="text-muted">
              No user email contains <span className="font-mono text-mono break-all text-fg">{search.q}</span>.
            </p>
            <Link to="/admin/users" className={cn(PAGER_LINK, 'mt-3')}>
              Clear search
            </Link>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="mt-4">
      <div className="overflow-x-auto">
        <UsersTable users={data.users} search={search} selectedId={selectedId} compact={compact} />
      </div>
      <nav aria-label="Users pages" className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption text-muted" aria-live="polite">
          Page {data.page} of {data.totalPages} · {data.total} {data.total === 1 ? 'user' : 'users'}
          {users.isPlaceholderData && ' · loading…'}
        </p>
        <div className="flex gap-2">
          {data.page > 1 && (
            <Link to="/admin/users" search={{ ...search, page: data.page - 1 === 1 ? undefined : data.page - 1 }} className={PAGER_LINK}>
              Previous page
            </Link>
          )}
          {data.page < data.totalPages && (
            <Link to="/admin/users" search={{ ...search, page: data.page + 1 }} className={PAGER_LINK}>
              Next page
            </Link>
          )}
        </div>
      </nav>
    </div>
  )
}
