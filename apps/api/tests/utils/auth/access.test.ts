import { describe, expect, test } from 'bun:test'
import type { Permission } from '../../../src/app'
import { adminPermissions } from '../../../src/modules/admin/permissions'
import { postsPermissions } from '../../../src/modules/posts/permissions'
import { ac, buildAccessControl, roles, statement } from '../../../src/utils/auth/access'
import { defineModulePermissions, mergeGrants, mergeStatements } from '../../../src/utils/auth/permissions'
import { DEFAULT_ROLE, ROLE_NAMES, rolesOf, roleRegistry, unknownRolesOf } from '../../../src/utils/auth/roles'
import { runInApiProcess } from '../../helpers/redis'

function permissionsOf(role: keyof typeof roles): string[] {
  const statements: Record<string, readonly string[]> = roles[role].statements
  return Object.entries(statements)
    .flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}`))
    .sort()
}

// Better Auth's own check (`hasPermission` in the admin plugin): any held role that authorizes wins,
// and a role missing from `roles` authorizes nothing.
function allows(stored: string | null, permissions: Record<string, string[]>): boolean {
  return rolesOf(stored).some((role) => {
    const known: Record<string, (typeof roles)[keyof typeof roles] | undefined> = roles
    return known[role]?.authorize(permissions).success === true
  })
}

describe('merged statement', () => {
  test('contains no impersonate action, at any resource', () => {
    const actions = Object.values(statement).flat()

    expect(actions).not.toContain('impersonate')
    expect(actions).not.toContain('impersonate-admins')
    expect(Object.keys(ac.statements)).toEqual(Object.keys(statement))
  })

  test('is the admin and posts module statements, merged', () => {
    expect(statement).toEqual({ ...adminPermissions.statement, ...postsPermissions.statement })
  })

  test('a duplicate resource key across modules fails', () => {
    const posts = defineModulePermissions({ statement: { posts: ['read'] }, grants: {} })
    const alsoPosts = defineModulePermissions({ statement: { posts: ['write'] }, grants: {} })

    expect(() => mergeStatements([posts, alsoPosts])).toThrow('Permission resource "posts" is declared by more than one module')
    expect(() => buildAccessControl([adminPermissions, defineModulePermissions({ statement: { user: ['list'] }, grants: {} })])).toThrow(
      'Permission resource "user" is declared by more than one module',
    )
  })

  test('declaring an impersonation action fails', () => {
    expect(() =>
      defineModulePermissions({ statement: { user: ['list', 'impersonate'] }, grants: {} }),
    ).toThrow('forbidden action(s) impersonate')
  })

  test('a grant to super_admin, or of an undeclared action, fails', () => {
    // Both are compile errors; casts must still fail at startup.
    const toSuperAdmin = { super_admin: { posts: ['read'] } } as unknown as Record<string, never>
    const undeclared = { user: { posts: ['delete'] } } as unknown as Record<string, never>

    expect(() => defineModulePermissions({ statement: { posts: ['read'] }, grants: toSuperAdmin })).toThrow('never name super_admin')
    expect(() => defineModulePermissions({ statement: { posts: ['read'] }, grants: undeclared })).toThrow('undeclared action(s) delete')
  })

  test('mergeGrants joins one role across modules', () => {
    const posts = defineModulePermissions({ statement: { posts: ['read', 'write'] }, grants: { user: { posts: ['read'] } } })

    expect(mergeGrants([adminPermissions, posts], 'admin')).toEqual({ user: ['list', 'get'], session: ['list'], role: ['read'] })
    expect(mergeGrants([adminPermissions, posts], 'user')).toEqual({ posts: ['read'] })
  })

  test('a duplicate resource key fails API startup', async () => {
    const script = `
      const { defineModulePermissions } = await import("./src/utils/auth/permissions.ts")
      const { buildAccessControl } = await import("./src/utils/auth/access.ts")
      const twice = defineModulePermissions({ statement: { posts: ["read"] }, grants: {} })
      buildAccessControl([twice, twice])
    `
    const result = await runInApiProcess(script, { LOG_LEVEL: 'silent' })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('declared by more than one module')
  })
})

describe('compiled roles', () => {
  test('every registry role is compiled', () => {
    expect(Object.keys(roles).sort()).toEqual([...ROLE_NAMES].sort())
  })

  // Snapshot of static-roles.md §5 for the actions that exist today; a grant change shows here.
  test('match the default permission matrix (DEC-033)', () => {
    expect(permissionsOf('super_admin')).toEqual([
      'posts:manage_all',
      'posts:read',
      'posts:write',
      'role:read',
      'session:delete',
      'session:list',
      'session:revoke',
      'user:ban',
      'user:create',
      'user:delete',
      'user:get',
      'user:list',
      'user:set-password',
      'user:set-role',
      'user:update',
    ])
    expect(permissionsOf('admin')).toEqual(['posts:manage_all', 'posts:read', 'posts:write', 'role:read', 'session:list', 'user:get', 'user:list'])
    expect(permissionsOf('user')).toEqual(['posts:read', 'posts:write'])
  })

  test('only super_admin may change roles or ban', () => {
    expect(allows('super_admin', { user: ['set-role', 'ban'] })).toBe(true)
    expect(allows('admin', { user: ['set-role'] })).toBe(false)
    expect(allows('admin', { user: ['list'], session: ['list'] })).toBe(true)
  })
})

describe('stored roles', () => {
  test('NULL and empty mean user, never an error or more access', () => {
    expect(rolesOf(null)).toEqual([DEFAULT_ROLE])
    expect(rolesOf(undefined)).toEqual([DEFAULT_ROLE])
    expect(rolesOf('')).toEqual([DEFAULT_ROLE])
    expect(unknownRolesOf(null)).toEqual([])
    expect(allows(null, { user: ['list'] })).toBe(false)
    expect(allows(null, {})).toBe(allows('user', {}))
  })

  test('an unknown role is reported and grants nothing', () => {
    expect(unknownRolesOf('ghost')).toEqual(['ghost'])
    expect(unknownRolesOf('admin,ghost')).toEqual(['ghost'])
    expect(allows('ghost', { user: ['list'] })).toBe(false)
    // A known role held next to it still counts (Better Auth: any held role).
    expect(allows('admin,ghost', { user: ['list'] })).toBe(true)
  })

  // Better Auth 1.7.15 (`hasPermission`) splits on commas and trims nothing, so neither does rolesOf:
  // a padded name is an unknown role and grants nothing, here and in Better Auth.
  test('is split like Better Auth: on commas, nothing trimmed', () => {
    expect(rolesOf('admin,super_admin')).toEqual(['admin', 'super_admin'])
    expect(rolesOf(' super_admin')).toEqual([' super_admin'])
    expect(unknownRolesOf('admin, super_admin')).toEqual([' super_admin'])
    expect(unknownRolesOf('  ')).toEqual(['  '])
    expect(allows(' super_admin', { user: ['set-role'] })).toBe(false)
  })

  test('the registry has super_admin and user', () => {
    expect(roleRegistry).toHaveProperty('super_admin')
    expect(roleRegistry).toHaveProperty('user')
  })
})

describe('Permission type', () => {
  test('accepts declared permissions only', () => {
    const allowed: Permission[] = ['user:list', 'user:set-role', 'session:revoke', 'role:read', 'posts:manage_all']
    // @ts-expect-error impersonation is not in the statement
    const impersonate: Permission = 'user:impersonate'
    // @ts-expect-error an undeclared resource
    const comments: Permission = 'comments:read'

    expect(allowed).toHaveLength(5)
    expect([impersonate, comments]).toHaveLength(2)
  })
})
