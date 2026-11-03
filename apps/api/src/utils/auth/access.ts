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
  // No prototype: Better Auth 1.7.15 looks a stored role up as `roles[name]` without an own-property
  // check, so on a plain object a stored "constructor" or "__proto__" finds an inherited member and
  // `.authorize()` throws (500 instead of 403). Unknown names must find nothing (TASK-05).
  const roles: Record<RoleName, Role> = Object.assign(
    Object.create(null) as Record<RoleName, Role>,
    Object.fromEntries(
      ROLE_NAMES.map((role) => [role, role === 'super_admin' ? ac.newRole(statement) : ac.newRole(mergeGrants(list, role))]),
    ),
  )
  return { statement, ac, roles }
}

// Runs at import: a duplicate resource key or a bad grant fails API startup.
export const { statement, ac, roles } = buildAccessControl(modules)

export type Permission = PermissionOf<MergedStatement<typeof modules>>

function permissionsIn(statements: Readonly<Record<string, readonly string[]>>): Permission[] {
  // Every pair comes from the merged statement, so each string is a `Permission`.
  return Object.entries(statements)
    .flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}` as Permission))
    .sort()
}

// Every permission that exists, sorted: what `super_admin` holds and the `permission` option accepts.
export const PERMISSIONS: readonly Permission[] = permissionsIn(statement)

// One registry role's compiled permissions, sorted (the compiled-roles snapshot, static-roles.md §11).
export function permissionsOf(role: RoleName): Permission[] {
  return permissionsIn(roles[role].statements)
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value)
}
