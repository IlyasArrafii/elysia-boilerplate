import { describe, expect, test } from 'bun:test'
import { adminPermissions } from '../../../src/modules/admin/permissions'
import type { Permission } from '../../../src/utils/auth'
import { PERMISSIONS, permissionsOf } from '../../../src/utils/auth/access'
import { ALLOWED_ADMIN_PATHS } from '../../../src/utils/auth/hooks'
import { isRoleName } from '../../../src/utils/auth/roles'

// The permission each allowlisted admin-plugin endpoint checks itself (better-auth 1.7.15,
// plugins/admin/routes.mjs). Written by hand: a Better Auth upgrade must be re-read here.
const ENDPOINT_PERMISSIONS: Readonly<Record<string, Permission>> = {
  '/admin/list-users': 'user:list',
  '/admin/set-role': 'user:set-role',
  '/admin/ban-user': 'user:ban',
  '/admin/unban-user': 'user:ban',
  '/admin/list-user-sessions': 'session:list',
  '/admin/revoke-user-session': 'session:revoke',
  '/admin/revoke-user-sessions': 'session:revoke',
  '/admin/remove-user': 'user:delete',
}

// This module's own routes (index.ts).
const ROUTE_PERMISSIONS: Readonly<Record<string, Permission>> = {
  'GET /api/admin/roles': 'role:read',
}

// Declared to mirror the admin plugin's statement, but no reachable route checks them: their
// endpoints (create-user, get-user, update-user, set-user-password) are not in API.md §3.1, and the
// plugin checks `session:delete` nowhere. Pinned so a change here is a reviewed decision (TASK-06).
const DECLARED_WITHOUT_ROUTE: readonly Permission[] = ['session:delete', 'user:create', 'user:get', 'user:set-password', 'user:update']

function declared(): Permission[] {
  return Object.entries(adminPermissions.statement)
    .flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}` as Permission))
    .sort()
}

describe('admin permissions', () => {
  test('every allowlisted admin endpoint has its permission recorded here', () => {
    expect(Object.keys(ENDPOINT_PERMISSIONS).sort()).toEqual([...ALLOWED_ADMIN_PATHS].sort())
  })

  test('every permission a reachable route checks is declared by this module', () => {
    const used = [...Object.values(ENDPOINT_PERMISSIONS), ...Object.values(ROUTE_PERMISSIONS)]

    expect(used.filter((permission) => !declared().includes(permission))).toEqual([])
  })

  test('every declared permission is used by a route, apart from the pinned exceptions', () => {
    const used = new Set<Permission>([...Object.values(ENDPOINT_PERMISSIONS), ...Object.values(ROUTE_PERMISSIONS)])

    expect(declared().filter((permission) => !used.has(permission))).toEqual([...DECLARED_WITHOUT_ROUTE])
  })

  test('the module grants appear in the compiled roles', () => {
    for (const [role, grants] of Object.entries(adminPermissions.grants)) {
      if (!isRoleName(role)) throw new Error(`Grant to unknown role ${role}`)
      const granted = Object.entries(grants ?? {}).flatMap(([resource, actions]) =>
        (actions ?? []).map((action) => `${resource}:${action}` as Permission),
      )
      expect(permissionsOf(role)).toEqual(expect.arrayContaining(granted))
    }
  })

  test('super_admin holds every declared admin permission; the statement holds no impersonation', () => {
    expect(permissionsOf('super_admin')).toEqual(expect.arrayContaining(declared()))
    expect(PERMISSIONS.filter((permission) => permission.includes('impersonate'))).toEqual([])
  })
})
