import { describe, expect, test } from 'bun:test'
import { MeService } from '../../../src/modules/me/service'
import { PERMISSIONS, permissionsOf } from '../../../src/utils/auth/access'

describe('MeService.permissions', () => {
  test('one registry role: its compiled permissions', () => {
    expect(MeService.permissions('admin')).toEqual({ roles: ['admin'], permissions: permissionsOf('admin') })
    expect(MeService.permissions('super_admin')).toEqual({ roles: ['super_admin'], permissions: [...PERMISSIONS] })
    expect(MeService.permissions('user')).toEqual({ roles: ['user'], permissions: [] })
  })

  // `user.role` is nullable with no default (TASK-03): NULL is `user`, never an error or more access.
  test('NULL or empty is the default role', () => {
    expect(MeService.permissions(null)).toEqual({ roles: ['user'], permissions: [] })
    expect(MeService.permissions(undefined)).toEqual({ roles: ['user'], permissions: [] })
    expect(MeService.permissions('')).toEqual({ roles: ['user'], permissions: [] })
  })

  test('an unknown role is listed but grants nothing', () => {
    expect(MeService.permissions('ghost')).toEqual({ roles: ['ghost'], permissions: [] })
  })

  test('a known role beside an unknown one keeps its grants', () => {
    expect(MeService.permissions('admin,ghost')).toEqual({ roles: ['admin', 'ghost'], permissions: permissionsOf('admin') })
    expect(MeService.permissions('super_admin,ghost').permissions).toEqual([...PERMISSIONS])
  })

  test('several known roles: the sorted union, each permission once', () => {
    const { permissions } = MeService.permissions('user,admin,super_admin')

    expect(permissions).toEqual([...PERMISSIONS])
    expect(new Set(permissions).size).toBe(permissions.length)
    expect(permissions).toEqual([...permissions].sort())
  })

  // Split like Better Auth: on commas, nothing trimmed.
  test('a padded name is an unknown role', () => {
    expect(MeService.permissions(' super_admin')).toEqual({ roles: [' super_admin'], permissions: [] })
    expect(MeService.permissions('admin, super_admin')).toEqual({ roles: ['admin', ' super_admin'], permissions: permissionsOf('admin') })
  })
})
