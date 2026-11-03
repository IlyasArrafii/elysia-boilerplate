import { createAccessControl, type Role } from 'better-auth/plugins/access'
import { adminPermissions } from '../../modules/admin/permissions'
import { mergeGrants, mergeStatements, type MergedStatement, type ModulePermissions, type PermissionOf } from './permissions'
import { ROLE_NAMES, type RoleName } from './roles'

// Every module with a `permissions.ts`, listed explicitly (no file globbing, apps/api R21).
const modules = [adminPermissions] as const

// `super_admin` holds every action of the merged statement, so a new module is covered on its own
// and an action left out of every statement (impersonation) is covered for nobody.
export function buildAccessControl<const M extends readonly ModulePermissions[]>(list: M) {
  const statement = mergeStatements(list)
  const ac = createAccessControl(statement)
  const roles = Object.fromEntries(
    ROLE_NAMES.map((role) => [role, role === 'super_admin' ? ac.newRole(statement) : ac.newRole(mergeGrants(list, role))]),
  ) as Record<RoleName, Role>
  return { statement, ac, roles }
}

// Runs at import: a duplicate resource key or a bad grant fails API startup.
export const { statement, ac, roles } = buildAccessControl(modules)

export type Permission = PermissionOf<MergedStatement<typeof modules>>
