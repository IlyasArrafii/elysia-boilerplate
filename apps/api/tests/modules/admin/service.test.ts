import { describe, expect, test } from 'bun:test'
import { AdminService } from '../../../src/modules/admin/service'
import { PERMISSIONS, permissionsOf } from '../../../src/utils/auth/access'
import { ROLE_NAMES, roleRegistry } from '../../../src/utils/auth/roles'

describe('AdminService.roles', () => {
  test('lists every registry role once, in registry order', () => {
    expect(AdminService.roles().items.map((item) => item.role)).toEqual([...ROLE_NAMES])
  })

  test('each role carries its registry label and description and nothing else', () => {
    for (const item of AdminService.roles().items) {
      expect(Object.keys(item).sort()).toEqual(['description', 'label', 'permissions', 'role'])
      expect(item.label).toBe(roleRegistry[item.role].label)
      expect(item.description).toBe(roleRegistry[item.role].description)
    }
  })

  test('permissions are the compiled ones Better Auth checks, sorted', () => {
    for (const item of AdminService.roles().items) {
      expect(item.permissions).toEqual(permissionsOf(item.role))
      expect(item.permissions).toEqual([...item.permissions].sort())
    }
  })

  // static-roles.md §5, written by hand so the catalogue is not checked only against itself.
  test('matches the default permission matrix', () => {
    const byRole = Object.fromEntries(AdminService.roles().items.map((item) => [item.role, item.permissions]))

    expect(byRole.super_admin).toEqual([...PERMISSIONS])
    expect(byRole.admin).toEqual(['role:read', 'session:list', 'user:get', 'user:list'])
    expect(byRole.user).toEqual([])
  })

  test('no role lists an impersonation action (DEC-032)', () => {
    const listed = AdminService.roles().items.flatMap((item) => item.permissions)

    expect(listed.filter((permission) => permission.includes('impersonate'))).toEqual([])
  })

  test('each call returns fresh arrays, so a caller cannot alter the next answer', () => {
    const first = AdminService.roles()
    first.items[0]?.permissions.splice(0)
    first.items.splice(0)

    expect(AdminService.roles().items.map((item) => item.role)).toEqual([...ROLE_NAMES])
    expect(AdminService.roles().items[0]?.permissions).toEqual(permissionsOf(ROLE_NAMES[0] ?? 'user'))
  })
})
