import { t } from 'elysia'
import { PERMISSIONS, type Permission } from '../../utils/auth/access'

// The statement always declares at least one action (permissions.ts), so the tuple is never empty.
const permission = t.UnionEnum(PERMISSIONS as [Permission, ...Permission[]])

export const MeModel = {
  // API.md §3.3. `roles` are the caller's stored roles as Better Auth reads them, unknown ones
  // included, so they carry no length limits: a value an operator wrote must not turn into a 500.
  permissions: t.Object({
    roles: t.Array(t.String()),
    permissions: t.Array(permission),
  }),
}

export type MePermissions = typeof MeModel.permissions.static
