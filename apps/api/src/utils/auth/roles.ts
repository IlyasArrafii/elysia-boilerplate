// The one list of roles (static-roles.md §2). Names are stored in `user.role`, so renaming one is a
// data migration. `super_admin` and `user` must always exist; `super_admin` is derived, never
// granted per module (access.ts).
export const roleRegistry = {
  super_admin: { label: 'Super Admin', description: 'Full access, including roles and bans.' },
  admin: { label: 'Admin', description: 'Manages all content; reads users and sessions.' },
  user: { label: 'User', description: 'Default role for every new account.' },
} as const satisfies Record<string, { label: string; description: string }>

export type RoleName = keyof typeof roleRegistry
export const DEFAULT_ROLE: RoleName = 'user'
export const SUPER_ADMIN: RoleName = 'super_admin'

export const ROLE_NAMES = Object.keys(roleRegistry) as RoleName[]

export function isRoleName(value: string): value is RoleName {
  return Object.hasOwn(roleRegistry, value)
}

// Exactly how Better Auth 1.7.15 reads `user.role` (`hasPermission`): an empty value is its default
// role, anything else is split on commas and nothing is trimmed. So `NULL` (the column has no
// default, TASK-03) is `user`, never an error and never more access, and " super_admin" is an unknown
// role, not super_admin: every check here agrees with the one Better Auth enforces.
export function rolesOf(stored: string | null | undefined): string[] {
  if (stored === null || stored === undefined || stored === '') return [DEFAULT_ROLE]
  return stored.split(',')
}

// The roles in a stored value that the registry does not know. Such a role grants nothing by itself:
// Better Auth finds no entry for it in `roles`. Known roles stored beside it keep their grants,
// because Better Auth grants a permission when any held role does (`hasPermission`, 1.7.15), and
// every check (the admin endpoints, the `permission` macro) goes through it. So "super_admin,retired"
// is still a super_admin, and a user whose roles are all unknown keeps only `auth: true` routes.
export function unknownRolesOf(stored: string | null | undefined): string[] {
  return rolesOf(stored).filter((role) => !isRoleName(role))
}
