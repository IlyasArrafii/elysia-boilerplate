import { permissionsOf } from '../../utils/auth/access'
import { ROLE_NAMES, roleRegistry } from '../../utils/auth/roles'
import type { RoleCatalogue } from './model'

export abstract class AdminService {
  // Every registry role in registry order, with the permissions compiled into Better Auth's access
  // control: the same `roles` the `permission` macro and the admin endpoints check, so the catalogue
  // cannot drift from what is enforced. Impersonation is in no statement, so it never appears.
  static roles(): RoleCatalogue {
    return {
      items: ROLE_NAMES.map((role) => ({
        role,
        label: roleRegistry[role].label,
        description: roleRegistry[role].description,
        permissions: permissionsOf(role),
      })),
    }
  }
}
