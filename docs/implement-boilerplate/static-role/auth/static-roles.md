# Static roles and permissions

Roles and permissions use Better Auth's admin plugin with access control (DEC-005). Roles are defined in code and projects add custom roles (DEC-022). Each module declares its own permissions, assembled in one place (DEC-023).

Better Auth API names below are checked against the installed admin plugin (1.7.18); *verify* them again after an upgrade. Configuration of Better Auth itself is in [README.md](README.md).

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

Permission answers "may this role do this kind of action?". Ownership answers "may this user do it to this record?". A feature flag answers "is this behaviour switched on?" and is never used for access ([feature-flags/targeting.md](../feature-flags/targeting.md)).

## 2. The role registry

`apps/api/src/utils/auth/roles.ts` is the one list of roles:

```ts
// apps/api/src/utils/auth/roles.ts
export const roleRegistry = {
  super_admin: { label: 'Super Admin', description: 'Full access, including roles and bans.' },
  admin:       { label: 'Admin',       description: 'Manages all content; reads users and sessions.' },
  user:        { label: 'User',        description: 'Default role for every new account.' },
  // custom roles, e.g. editor: { label: 'Editor', description: 'Manages all posts; no user access.' },
} as const satisfies Record<string, { label: string; description: string }>

export type RoleName = keyof typeof roleRegistry
export const DEFAULT_ROLE: RoleName = 'user'
export const SUPER_ADMIN: RoleName = 'super_admin'
```

- Role names are `snake_case`, stable, stored in the database. Renaming one is a data migration.
- `super_admin` and `user` must always exist. `super_admin` is never granted per module: it is derived (§4).
- Better Auth stores several roles comma-separated (`"admin,editor"`). A check passes if any held role grants the permission (checked in 1.7.18 `hasPermission`). The MVP UI assigns one role.
- Role names are split on commas and nothing is trimmed, exactly as Better Auth does: `" super_admin"` or `"admin, super_admin"` holds an unknown role, not `super_admin`, and is not counted as a usable `super_admin`.
- A stored role the registry does not know grants nothing by itself, and takes nothing away from known roles stored beside it: `"super_admin,retired_role"` is still a `super_admin`, `"admin,retired_role"` an `admin`. This is Better Auth's own rule, and every check (the admin endpoints and the `permission` macro through `userHasPermission`) uses it, so there is no second behaviour to keep in step. A user whose roles are all unknown keeps only `auth: true` routes.
- `user.role` is nullable with no database default. `NULL` or empty means `user` (Better Auth reads it as its `defaultRole`): never an error, never more access, and not reported by `rbac.unknown_role`.

## 3. Declaring permissions in a module

```ts
// apps/api/src/modules/posts/permissions.ts
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
// apps/api/src/modules/admin/permissions.ts
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

Better Auth's own `user` statement also lists `impersonate`, `impersonate-admins`, `set-email` and `set-phone`, and none of them is in ours. The admin plugin checks `set-email` and `set-phone` only in its `update-user` endpoint, when the body changes `email`/`emailVerified` or `phoneNumber`/`phoneNumberVerified`. That endpoint is blocked (§7), so no role can change another user's email or phone number.

Rules:
- A resource belongs to one module. Two modules declaring the same resource key fail startup.
- Resource keys are the module name (`posts`) or Better Auth's built-in names (`user`, `session`).
- Actions are `snake_case` verbs, or Better Auth's kebab-case actions for built-in resources. Keep them coarse (`read`, `write`, `manage_all`, `publish`); not one action per endpoint.
- Every permission protects at least one API route. No UI-only permissions.
- A Better Auth built-in action is added to the statement only when a feature uses it, with a decision if it is security-sensitive.
- Exceptions, from DEC-033's list:
  - `user:create`, `user:update`, `user:set-password` and `session:delete` are in the `admin` statement but protect no reachable route. Their admin-plugin endpoints are blocked (§7), and no 1.7.18 admin endpoint checks `session:delete`.
  - `user:get` gates only the web's user-detail screen, because `get-user` is blocked (§6).

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
- `Permission` is exported as a type for the `permission` route option. The web app's `can()` takes the same union, derived from the `GET /api/me/permissions` response schema through Eden.

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

Guests reach only routes marked **Public** in [API.md](../API.md).

## 6. Permissions in the web app

The web app never decides access; it hides what the API would refuse anyway.

- `GET /api/me/permissions` returns `{ roles, permissions }`. `usePermissions()` in `features/auth` caches it per session and exposes `can(permission)`. Dropped on sign-in, sign-up and sign-out, and when a session refetch shows another identity. It is re-fetched after any 403 and once it is older than 30 s (the query client's `staleTime`), so a role change shows up through one of those.
- Route `beforeLoad` reads the same query (`requirePermission`) to redirect when a page's permission is missing.
- `usePermissions()` returns `{ status, roles, permissions, can, error, retry }`; the query is keyed by user id, and `can()` is false while loading, after a failed permissions or session fetch (even with an older user and answer cached), for guests and after sign-out. Guards: `requireSession` (a `_authed` layout, guests → `/login?redirect=<path>`) and `requirePermission(queryClient, session, permission)` (→ `/?notice=forbidden`, explained by the app shell). Both read with `fetchQuery`, so a stale cached answer is re-checked.
- Posts pages: the layout `routes/_authed/posts/route.tsx` requires `posts:read` for `/posts`, `/posts/:postId` and `/posts/:postId/edit`; the edit route also requires `posts:write`. Ownership needs the post, so the edit page and the detail page's Edit/Delete actions apply the API's rule themselves: `posts:write` and (author or `posts:manage_all`), hidden while permissions load or after they fail. A `403` from a write re-fetches the permissions, a `401` re-reads the session (the session watcher then redirects to `/login`), and a `404` invalidates the post and the lists. The header's Posts link needs `posts:read`.
- Posts form limits: the client checks only the API's minimums (title ≥ 3, content ≥ 10, counted as typed, no trimming). The maximums are set per deployment (`POSTS_TITLE_MAX_LENGTH`, `POSTS_CONTENT_MAX_LENGTH`) and are not exposed to the web app, so a too-long value is left to the API's `400 VALIDATION_ERROR`, shown on the field. The list asks for the API's default page size, 20.

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

Admin pages: `/admin` sends a visitor to the first screen they may open (users, then roles), else `/?notice=forbidden`. The user detail reads `list-users` filtered on the id, because `get-user` is not on the API's allowlist ([API.md §3.1](../API.md)), so it needs `user:list` as well as `user:get`. The role select is filled from the catalogue, so changing a role also needs `role:read`; the admin plugin's `revoke-user-sessions` (revoke all) uses `session:revoke` like single revocation. Role change, ban and unban first re-read the target and refuse (`USER_CHANGED`) when the roles shown or the ban state no longer match the confirmation, and revoking one session first checks it still exists (`SESSION_NOT_FOUND`); this narrows, but cannot close, the window for acting on a stale screen. Session tokens are never cached: revoking one reads its token uncached right before sending. Screens render only on confirmed grants, and a confirmed loss of access drops the cached admin data; a 403 re-reads the signed-in user's permissions, a 401 their session.

A feature that needs a new capability adds the permission to the **module** that serves its data.

## 7. Guard rules (Better Auth `hooks.before`)

In `apps/api/src/utils/auth/hooks.ts`:

| Path | Rule | Error |
|:---|:---|:---|
| `/admin/set-role` | `body.userId === session.user.id` | `400 CANNOT_CHANGE_OWN_ROLE` |
| `/admin/set-role` | every requested role is in the registry | `400 INVALID_ROLE` |
| `/admin/set-role`, `/admin/ban-user`, `/admin/unban-user`, `/admin/list-user-sessions`, `/admin/revoke-user-sessions`, `/admin/remove-user` | `body.userId` is a non-empty string | `400 INVALID_USER_ID` |
| `/admin/set-role` without `super_admin` in the new roles, `/admin/ban-user`, `/admin/remove-user` | the target is not the last usable `super_admin` | `400 LAST_SUPER_ADMIN` |
| `/admin/ban-user`, `/admin/remove-user` | `body.userId === session.user.id` | `400 CANNOT_TARGET_SELF` |
| `/admin/impersonate-user`, `/admin/stop-impersonating` and any other admin-plugin path not listed in [API.md §3.1](../API.md) | always | `404 NOT_FOUND`, plus `audit.auth.blocked_endpoint` |

The last rule is an **allowlist**: admin-plugin paths are allowed only if API.md lists them, so a Better Auth upgrade that adds an endpoint cannot open it silently. It applies to server-side `auth.api` calls too, with one exception: `has-permission` without a `request`, which the `permission` macro needs. The self, role and last-`super_admin` guards run only for a signed-in caller; a guest gets the endpoint's own 401. A `role` sent as one string is one role name: `"admin,super_admin"` is `INVALID_ROLE`, not two roles. Errors are thrown as Better Auth `APIError`, keeping Better Auth's format.

**`userId`.** `hooks.before` runs before Better Auth validates the body, and the admin plugin reads `userId` with `z.coerce.string()`: `["<own id>"]`, `[["<own id>"]]` or a number would reach the endpoint as a string the self guards never compared. So `userId` must already be a string; anything else is `INVALID_USER_ID`, before any other check. The audit hooks read the target with the same rule (`utils/auth/body.ts`).

**At least one usable `super_admin` remains.** "No self-demotion" alone does not guarantee this: two `super_admin`s can demote, ban or remove each other at the same moment, each passing every check, and leave none. The guarantee comes from serialization:

- `set-role`, `ban-user`, `unban-user` and `remove-user` run in **one PostgreSQL transaction that holds a transaction-scoped advisory lock** (`utils/auth/user-mutation-lock.ts`), shared by every API instance. Every query the endpoint makes, Better Auth's included, runs in that transaction: the API's `db` (`utils/db/index.ts`) is bound to it for the duration, since Better Auth 1.7.18 cannot be handed a transaction per request: its HTTP handler always runs on its own adapter. So the checks and the write commit together or not at all.
- If the lock's connection is lost, PostgreSQL releases the lock and rolls the writes back. Each mutation uses a one-connection client of its own, closed as soon as the transaction settles: postgres-js 3.4.9 reconnects a lost connection and would run a still-running endpoint's remaining queries on the new connection, outside the transaction. Closing the client makes them fail instead. A holder idle in its transaction for 10 s loses its connection the same way.
- Waiting takes no shared-pool connection: in each process one mutation holds the lock and up to 32 wait in memory. A caller the endpoint would refuse (no session: 401; no role granting the endpoint's permission: Better Auth's own 403) is answered before queueing, and the body (16 KiB at most, else 413 `PAYLOAD_TOO_LARGE`) is read before queueing. A full queue, or a wait over 5 s in the queue or for the database lock, is `503 USER_MUTATION_BUSY` with `Retry-After: 1`. The endpoint still decides inside the lock; the early answer is only an early answer.
- Under the lock, before the endpoint writes, `LAST_SUPER_ADMIN` refuses a demotion, ban or removal that would leave no usable `super_admin` (holds `super_admin`, and is not banned, or the ban has expired), checked against the database. It is checked only for a caller who holds the endpoint's permission, so nobody else learns who the last `super_admin` is. A request that waited for the lock sees the earlier change: its caller has usually just lost `super_admin` and gets the endpoint's own 403, because every request reads the session and the user's current role from PostgreSQL (DEC-054).
- A server-side `auth.api` call to one of these endpoints must run inside `userMutationLock.run()`; outside it the guard throws, so no caller can skip the lock.
- The audit hooks read the previous role and ban state in the same transaction, so concurrent changes record an unbroken `from`/`to` chain. Their events are emitted only after the commit: a rolled-back change is never reported.

Writes outside the API (SQL by an operator, the seed) are not covered. The one exception is `bun run role:set`.

**Setting a role from the terminal.** `bun run role:set <email> <role>` (`apps/api/scripts/role-set.ts`; at the repo root or in `apps/api`) gives an existing user exactly one registry role, for example the first `admin` of a deployment. It keeps the rules of `/admin/set-role`:
- It runs inside `userMutationLock.run()`, so its checks and its write see every earlier change, and it waits for the lock like the endpoints do.
- The role must be in the registry. Demoting the last usable `super_admin` is refused (`wouldRemoveLastSuperAdmin`, `utils/auth/super-admins.ts`).
- The email is matched ignoring case. No match, or more than one row when case is ignored, changes nothing.
- The role replaces every stored role. If it is already the only role held (`NULL` counts as `user`), nothing is written and nothing is emitted.
- A change emits `audit.user.role_changed` with `actorId: "cli"` once the transaction commits ([README.md §6](README.md#6-audit-events-dec-016)). It applies on the user's next request, since sessions are read from PostgreSQL (DEC-054).
- Before exiting it flushes telemetry, so with `LOG_MONGO_URL` set the event reaches the log store, its only lasting record. If that flush fails after a change, it says so and still exits `0`, because the role did change.
- It writes `user.role` with Drizzle, not through Better Auth, so `databaseHooks` do not run. A side effect added to role changes in `database-hooks.ts` must be repeated in `role-set.ts`.
- Its output names the user ID, never the email.
- Exit codes follow the convention in the root README's [Commands](../../../../README.md#commands): `0` when the user holds the role afterwards (changed or already held), `1` when refused or failed (unknown email, an email two rows share, the last `super_admin`), and `2` on wrong usage (wrong argument count, an email where the role goes, an unknown role).

**Bans at sign-in.** The admin plugin (1.7.18) lifts an expired ban when a session is created by reading the user and then clearing the ban fields unconditionally, so a ban imposed in between would be wiped. That write is cancelled (`utils/auth/bans.ts`); the lift is one conditional `UPDATE` that matches only a ban that is still the expired one, and when it does not match, the ban now in the database decides (`403 BANNED_USER`). A genuine expiry still emits `audit.user.unbanned` without an actor. After the session row is written, the user is read again with `FOR SHARE` (which waits for an uncommitted ban): a ban that landed between the check and the write deletes the new session and refuses the sign-in, because the ban's own session deletion could not have seen it. A known side effect: since the cancelled write returns no user, Better Auth 1.7.18 logs one error-level line on each sign-in that lifts an expired ban (`Failed to refresh committed user sessions in secondary storage`, with a `TypeError`). The sign-in still succeeds.

At startup the API counts users whose role is not in the registry and emits `rbac.unknown_role` (warn). Their unknown roles grant nothing until they are reassigned; known roles stored beside one still apply (§2). Implemented in `utils/auth/unknown-roles.ts`, called from `src/index.ts` after `listen`; a database that is down only logs a warning.

## 8. Adding a custom role

Example: an `editor` who manages all posts but cannot see users.

1. Add `editor` to `roleRegistry` with a label and description.
2. Add a grant in each module the role needs: `editor: { posts: ['read', 'write', 'manage_all'] }`.
3. Update the matrix in §5 and the permission-matrix tests.
4. Deploy. A `super_admin` assigns it with `authClient.admin.setRole({ userId, role: 'editor' })`, or an operator with `bun run role:set <email> editor` (§7).

Removing a role: reassign its users first (`rbac.unknown_role` shows who is left), then delete the entry and its grants. Renaming: add the new role, migrate users with a SQL migration, remove the old one.

## 9. Adding a custom permission

Example: posts gain `publish`.

1. Add `'publish'` to the `posts` statement.
2. Grant it to the roles that need it (`super_admin` gets it automatically).
3. Use it: `{ permission: 'posts:publish' }`.
4. Update §5, §6 (if the UI uses it) and [API.md](../API.md).
5. Extend the tests.

A new module follows the same steps with a new resource key.

## 10. Why roles are code

Roles are code so they can be reviewed, typed and tested, and every change ships through a deploy. Changing a role means editing `roles.ts` and the module grants (§8, §9). An own `role_definition` table next to the admin plugin is not an option: it would be a second source of truth and break DEC-005.

## 11. Tests

Folder: `apps/api/tests/utils/auth/` and `apps/api/tests/modules/<module>/` ([TESTING.md](../TESTING.md)). The matrix (through the `permission` macro: every registry role, plus `NULL`, unknown and mixed roles, × every permission; guest → 401) and the compiled-roles snapshot (`__snapshots__/permissions.test.ts.snap`, checked against a hand-written copy of §5) are in `tests/modules/me/permissions.test.ts`. A stored role named like an inherited object member (`constructor`, `__proto__`, `toString`) is an unknown role like any other: the compiled `roles` object has no prototype (`access.ts`), because Better Auth looks roles up as `roles[name]`.

- **Matrix test:** every registry role × every protected route → expected status (2xx vs 403). Guest → 401.
- **Compiled-roles snapshot:** `role → sorted permission list`; a grant change shows as a reviewable diff.
- **Guard tests:** self role change, unknown role, self ban, impersonation endpoints → 404 for `super_admin`, unlisted admin path → 404.
- **Statement test:** the merged statement contains no `impersonate` or `impersonate-admins` action.
- **Startup tests:** duplicate resource key fails startup; unknown role in the database emits `rbac.unknown_role`.
- **`role:set` tests** (`apps/api/tests/scripts/role-set.test.ts`): argument parsing, the case-insensitive match, the last-`super_admin` refusal, waiting for the user mutation lock, the `cli` audit event and the exit codes.
