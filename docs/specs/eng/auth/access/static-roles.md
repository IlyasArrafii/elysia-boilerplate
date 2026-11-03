# Stage 1: Static Roles (RBAC, default)

> **Stage 1, the default (DEC-042).** The first of three access stages; how to choose and move on: [README.md](README.md). Formerly `auth/rbac.md`.

Roles and permissions use Better Auth's admin plugin with access control (DEC-005). Roles are defined in code and projects add custom roles (DEC-022). Each module declares its own permissions, assembled in one place (DEC-023).

Better Auth API names below come from the admin plugin docs as of 2026-11; *verify* them against the installed version.

## 1. Vocabulary

| Term | Meaning | Example |
|:---|:---|:---|
| **Resource** | A thing that can be acted on, owned by exactly one module | `posts`, `role`, `user` |
| **Action** | What can be done to a resource | `read`, `write`, `manage_all` |
| **Statement** | A module's map of resource → allowed actions | `{ posts: ['read', 'write', 'manage_all'] }` |
| **Permission** | One `resource:action` pair, the string routes use | `posts:write` |
| **Role** | A named set of permissions, stored as a string on `user.role` | `admin` |
| **Grant** | The permissions a module gives to one role | `user: { posts: ['read', 'write'] }` |
| **Ownership rule** | A check on a specific record, in the service after the permission passes | "only the author edits this post" |

Permission answers "may this role do this kind of action?". Ownership answers "may this user do it to this record?". A feature flag answers "is this behaviour switched on?" and is never used for access ([feature-flags/targeting.md](../../feature-flags/targeting.md)).

## 2. The role registry

`apps/api/src/utils/auth/roles.ts` is the one list of roles:

```ts
// sketch
export const roleRegistry = {
  super_admin: { label: 'Super Admin', description: 'Full access, including roles and bans.' },
  admin:       { label: 'Admin',       description: 'Manages all content; reads users and sessions.' },
  user:        { label: 'User',        description: 'Default role for every new account.' },
  // custom roles, e.g. editor: { label: 'Editor', description: 'Manages all posts; no user access.' },
} as const satisfies Record<string, { label: string; description: string }>

export type RoleName = keyof typeof roleRegistry
export const DEFAULT_ROLE: RoleName = 'user'
```

- Role names are `snake_case`, stable, stored in the database. Renaming one is a data migration.
- `super_admin` and `user` must always exist. `super_admin` is never granted per module: it is derived (§4).
- Better Auth stores several roles comma-separated (`"admin,editor"`). A check passes if any held role grants the permission (*verify*). The MVP UI assigns one role.

## 3. Declaring permissions in a module

```ts
// apps/api/src/modules/posts/permissions.ts (sketch)
export const postsPermissions = defineModulePermissions({
  statement: { posts: ['read', 'write', 'manage_all'] },
  grants: {
    admin: { posts: ['read', 'write', 'manage_all'] },
    user:  { posts: ['read', 'write'] },
  },
})
```

The `admin` module declares the Better Auth built-in actions **we use**, listed explicitly. It does **not** spread `defaultStatements`, so the admin plugin's impersonation actions never exist in our access control (DEC-032):

```ts
// apps/api/src/modules/admin/permissions.ts (sketch)
export const adminPermissions = defineModulePermissions({
  statement: {
    user:    ['create', 'list', 'get', 'update', 'set-role', 'ban', 'delete', 'set-password'],
    session: ['list', 'revoke', 'delete'],
    role:    ['read'],
  },
  grants: {
    admin: { user: ['list', 'get'], session: ['list'], role: ['read'] },   // DEC-033
  },
})
```

Rules:
- A resource belongs to one module. Two modules declaring the same resource key fail startup.
- Resource keys are the module name (`posts`) or Better Auth's built-in names (`user`, `session`).
- Actions are `snake_case` verbs, or Better Auth's kebab-case actions for built-in resources. Keep them coarse (`read`, `write`, `manage_all`, `publish`); not one action per endpoint.
- Every permission protects at least one API route. No UI-only permissions.
- A Better Auth built-in action is added to the statement only when a feature uses it, with a decision if it is security-sensitive.

## 4. Assembling Better Auth's access control

`apps/api/src/utils/auth/access.ts` merges every module explicitly (no file globbing):

```ts
// sketch
const modules = [adminPermissions, postsPermissions /* , new modules here */]

const statement = mergeStatements(modules)          // throws on duplicate resource keys
export const ac = createAccessControl(statement)

export const roles = {
  super_admin: ac.newRole(statement),               // every action of every statement
  ...Object.fromEntries(
    roleNamesExcept('super_admin').map((r) => [r, ac.newRole(mergeGrants(modules, r))]),
  ),
}

export type Permission = PermissionKeys<typeof statement>   // 'posts:read' | 'user:list' | ...
```

- `super_admin` gets every action in the statement. A new module is covered automatically; actions left out of the statement (such as impersonation) are never covered.
- A role with no grants is valid: it can sign in and call `auth: true` routes only.
- `ac` and `roles` go to `admin({ ac, roles, defaultRole: 'user' })`.
- `Permission` is exported as a type for the `permission` route option and the web app's `can()`.

## 5. Default permission matrix

| Permission | `super_admin` | `admin` | `user` | Guest |
|:---|:---:|:---:|:---:|:---:|
| `posts:read` | ✅ | ✅ | ✅ | ❌ |
| `posts:write` (own posts; ownership rule in the service) | ✅ | ✅ | ✅ | ❌ |
| `posts:manage_all` | ✅ | ✅ | ❌ | ❌ |
| `role:read` | ✅ | ✅ | ❌ | ❌ |
| `user:list`, `user:get` | ✅ | ✅ | ❌ | ❌ |
| `session:list` | ✅ | ✅ | ❌ | ❌ |
| `user:create`, `user:update`, `user:set-role`, `user:ban`, `user:delete`, `user:set-password` | ✅ | ❌ | ❌ | ❌ |
| `session:revoke`, `session:delete` | ✅ | ❌ | ❌ | ❌ |

Guests reach only routes marked **Public** in [API.md](../../API.md).

## 6. Permissions in the web app

The web app never decides access; it hides what the API would refuse anyway.

- `GET /api/me/permissions` returns `{ roles, permissions }`. `usePermissions()` in `features/auth` caches it per session and exposes `can(permission)`. Cleared on sign-in, sign-out and after a role change.
- Route `beforeLoad` uses the same query (`ensureQueryData`) to redirect when a page's permission is missing.

| Feature | Page / action | Needs |
|:---|:---|:---|
| `posts` | List, view | `posts:read` |
| `posts` | Create; edit/delete own | `posts:write` |
| `posts` | Edit/delete any | `posts:manage_all` |
| `admin` | Users list, user detail | `user:list`, `user:get` |
| `admin` | Change role | `user:set-role` |
| `admin` | Ban / unban | `user:ban` |
| `admin` | Sessions list / revoke | `session:list` / `session:revoke` |
| `admin` | Role catalogue | `role:read` |
| `profile` | Edit own name and avatar | `auth: true` only |

A feature that needs a new capability adds the permission to the **module** that serves its data.

## 7. Guard rules (Better Auth `hooks.before`)

In `apps/api/src/utils/auth/hooks.ts`:

| Path | Rule | Error |
|:---|:---|:---|
| `/admin/set-role` | `body.userId === session.user.id` | `400 CANNOT_CHANGE_OWN_ROLE` |
| `/admin/set-role` | every requested role is in the registry | `400 INVALID_ROLE` |
| `/admin/ban-user`, `/admin/remove-user` | `body.userId === session.user.id` | `400 CANNOT_TARGET_SELF` |
| `/admin/impersonate-user`, `/admin/stop-impersonating` and any other admin-plugin path not listed in [API.md §3.1](../../API.md) | always | `404 NOT_FOUND`, plus `audit.auth.blocked_endpoint` |

The last rule is an **allowlist**: admin-plugin paths are allowed only if API.md lists them, so a Better Auth upgrade that adds an endpoint cannot open it silently. Errors are thrown as Better Auth `APIError`, keeping Better Auth's format. Because only `super_admin` holds `user:set-role` and nobody changes their own role, at least one `super_admin` always remains.

At startup the API counts users whose role is not in the registry and emits `rbac.unknown_role` (warn). Those users get no permissions until reassigned.

## 8. Adding a custom role

Example: an `editor` who manages all posts but cannot see users.

1. Add `editor` to `roleRegistry` with a label and description.
2. Add a grant in each module the role needs: `editor: { posts: ['read', 'write', 'manage_all'] }`.
3. Update the matrix in §5 and the permission-matrix tests.
4. Deploy. A `super_admin` assigns it with `authClient.admin.setRole({ userId, role: 'editor' })`.

Removing a role: reassign its users first (`rbac.unknown_role` shows who is left), then delete the entry and its grants. Renaming: add the new role, migrate users with a SQL migration, remove the old one.

## 9. Adding a custom permission

Example: posts gain `publish`.

1. Add `'publish'` to the `posts` statement.
2. Grant it to the roles that need it (`super_admin` gets it automatically).
3. Use it: `{ permission: 'posts:publish' }`.
4. Update §5, §6 (if the UI uses it) and [API.md](../../API.md).
5. Extend the tests.

A new module follows the same steps with a new resource key.

## 10. Runtime-editable roles (next stage)

At stage 1 roles are code so they can be reviewed, typed and tested. If a non-developer must create or edit roles from a UI, move to **stage 2** with Better Auth dynamic access control ([single-org.md](single-org.md)), following Step A in [migration.md §3](migration.md). An own `role_definition` table next to the admin plugin is not an option: it would be a second source of truth and break DEC-005.

## 11. Tests

Folder: `apps/api/tests/utils/auth/` and `apps/api/tests/modules/<module>/` ([TESTING.md](../../TESTING.md)).

- **Matrix test:** every registry role × every protected route → expected status (2xx vs 403). Guest → 401.
- **Compiled-roles snapshot:** `role → sorted permission list`; a grant change shows as a reviewable diff.
- **Guard tests:** self role change, unknown role, self ban, impersonation endpoints → 404 for `super_admin`, unlisted admin path → 404.
- **Statement test:** the merged statement contains no `impersonate` or `impersonate-admins` action.
- **Startup tests:** duplicate resource key fails startup; unknown role in the database emits `rbac.unknown_role`.
