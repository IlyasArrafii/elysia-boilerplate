import { defineModulePermissions } from '../../utils/auth/permissions'

// The Better Auth admin-plugin actions we use, listed explicitly. `defaultStatements` is never
// spread, so the plugin's impersonation actions never exist in our access control (DEC-032, R24).
// `role:read` protects the role catalogue route (TASK-06).
export const adminPermissions = defineModulePermissions({
  statement: {
    user: ['create', 'list', 'get', 'update', 'set-role', 'ban', 'delete', 'set-password'],
    session: ['list', 'revoke', 'delete'],
    role: ['read'],
  },
  grants: {
    // DEC-033: admins read users, sessions and roles; only super_admin changes them.
    admin: { user: ['list', 'get'], session: ['list'], role: ['read'] },
  },
})
