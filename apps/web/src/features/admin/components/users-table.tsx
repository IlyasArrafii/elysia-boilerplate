import { cn } from '@repo/ui'
import { Link } from '@tanstack/react-router'
import { formatDateTime, type AdminUser, type UsersSearch } from '../lib/users'
import { RoleList, UserStatus } from './user-status'

interface UsersTableProps {
  users: readonly AdminUser[]
  search: UsersSearch
  selectedId: string | undefined
  // Narrow (next to an open detail): secondary columns are left out.
  compact: boolean
}

const LINK = cn(
  'inline-flex min-h-11 max-w-full items-center rounded-sm break-all text-accent underline-offset-2 hover:underline',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
)

// The master list (DESIGN.md §6). Phones keep email, role and status; name and creation date need more room.
export function UsersTable({ users, search, selectedId, compact }: UsersTableProps) {
  return (
    <table className="w-full border-collapse text-left">
      <caption className="sr-only">Users, newest first</caption>
      <thead>
        <tr className="border-b border-border text-caption text-muted">
          <th scope="col" className="py-2 pr-3 pl-3 font-medium">
            Email
          </th>
          {!compact && (
            <th scope="col" className="hidden py-2 pr-3 font-medium md:table-cell">
              Name
            </th>
          )}
          <th scope="col" className="py-2 pr-3 font-medium">
            Role
          </th>
          <th scope="col" className="py-2 pr-3 font-medium">
            Status
          </th>
          {!compact && (
            <th scope="col" className="hidden py-2 pr-3 font-medium lg:table-cell">
              Created
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {users.map((user) => {
          const selected = user.id === selectedId
          return (
            <tr
              key={user.id}
              className={cn('border-b border-l-2 border-b-border align-middle', selected ? 'border-l-accent bg-hover' : 'border-l-transparent')}
            >
              <td className="py-1 pr-3 pl-3">
                <Link
                  to="/admin/users/$userId"
                  params={{ userId: user.id }}
                  search={search}
                  aria-current={selected ? 'page' : undefined}
                  className={LINK}
                >
                  {user.email}
                </Link>
              </td>
              {!compact && <td className="hidden py-1 pr-3 md:table-cell">{user.name}</td>}
              <td className="py-1 pr-3">
                <RoleList roles={user.roles} />
              </td>
              <td className="py-1 pr-3">
                <UserStatus user={user} />
              </td>
              {!compact && (
                <td className="hidden py-1 pr-3 font-mono text-mono whitespace-nowrap text-muted lg:table-cell">
                  {formatDateTime(user.createdAt)}
                </td>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function UsersSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading users" className="mt-4 grid gap-1">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="h-11 animate-pulse bg-hover" />
      ))}
    </div>
  )
}
