import { defineModulePermissions } from '../../utils/auth/permissions'

// static-roles.md §3, §5. `write` covers the caller's own posts; editing or deleting someone else's
// needs `manage_all` as well (ownership rule in PostService, apps/api R22).
export const postsPermissions = defineModulePermissions({
  statement: {
    posts: ['read', 'write', 'manage_all'],
  },
  grants: {
    admin: { posts: ['read', 'write', 'manage_all'] },
    user: { posts: ['read', 'write'] },
  },
})
