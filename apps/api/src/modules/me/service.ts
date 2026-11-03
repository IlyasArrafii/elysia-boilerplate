import { permissionsOf, type Permission } from '../../utils/auth/access'
import { isRoleName, rolesOf } from '../../utils/auth/roles'
import type { MePermissions } from './model'

export abstract class MeService {
  // The union of what every held role grants: Better Auth's rule (any held role is enough), applied
  // to the same compiled roles the `permission` macro checks. NULL is `user`; an unknown role adds
  // nothing but is still listed among the roles (static-roles.md §2). Computed per call, never cached.
  static permissions(storedRole: string | null | undefined): MePermissions {
    const roles = rolesOf(storedRole)
    const granted = new Set<Permission>()
    for (const role of roles) {
      if (isRoleName(role)) for (const permission of permissionsOf(role)) granted.add(permission)
    }
    return { roles, permissions: [...granted].sort() }
  }
}
