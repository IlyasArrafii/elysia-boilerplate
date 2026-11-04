import type { AdminUser } from '../lib/users'

// Ban state as text with a glyph, never colour alone (DESIGN.md §12).
export function UserStatus({ user }: Readonly<{ user: Pick<AdminUser, 'banned'> }>) {
  if (user.banned) {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-danger">
        <span aria-hidden="true">⊘</span>Banned
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-caption text-success">
      <span aria-hidden="true">✓</span>Active
    </span>
  )
}

export function RoleList({ roles }: Readonly<{ roles: readonly string[] }>) {
  return <span className="font-mono text-mono break-all">{roles.join(', ')}</span>
}
