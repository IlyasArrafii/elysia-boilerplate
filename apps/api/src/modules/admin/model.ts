import { t } from 'elysia'
import { PERMISSIONS, type Permission } from '../../utils/auth/access'
import { ROLE_NAMES, type RoleName } from '../../utils/auth/roles'

// The statement and the registry are never empty (permissions.ts, roles.ts), so neither tuple is.
const permission = t.UnionEnum(PERMISSIONS as [Permission, ...Permission[]])
const role = t.UnionEnum(ROLE_NAMES as [RoleName, ...RoleName[]])

export const AdminModel = {
  // API.md §3.5: the code-defined catalogue, so no pagination `meta`.
  roles: t.Object({
    items: t.Array(
      t.Object({
        role,
        label: t.String({ minLength: 1 }),
        description: t.String({ minLength: 1 }),
        permissions: t.Array(permission),
      }),
    ),
  }),
}

export type RoleCatalogue = typeof AdminModel.roles.static
