// Public interface of the auth feature (apps/web R4, R5). Everything else in this folder is internal.
//
// Route files
//   LoginPage, RegisterPage        /login and /register; give them `validateSearch: validateLoginSearch` and
//                                  `beforeLoad: redirectSignedIn`.
//   requireSession                 `beforeLoad` of a protected layout: guests go to /login?redirect=<here>;
//                                  returns `{ session }` into the route context. Throws if the session cannot be
//                                  checked, so pair it with `errorComponent: SessionCheckError`.
//   requirePermission              `beforeLoad` of a page that needs one permission (posts, admin), after
//                                  requireSession: `requirePermission(context.queryClient, context.session, 'posts:read')`.
//                                  Without it the visitor goes to `/?notice=forbidden`, which AccessNotice explains.
//   AccessPage                     /access, the signed-in user's roles and permissions.
//
// Components (TASK-10, TASK-16, TASK-17)
//   useSession()                   The session (`AuthSession | null`); `sessionQueryOptions` for loaders.
//   usePermissions()               `{ status, roles, permissions, can, error, retry }`. `can()` is false while the
//                                  answer is loading or unavailable, and after sign-out. UX only: the API decides.
//   permissionsQueryOptions(id)    The same data for loaders.
//   useSignOut()                   Signs out and drops every cached query.
//   useUpdateUser()                Saves the signed-in user's `name` and `image` (UserUpdate) and refreshes the
//                                  session everywhere; `updateUserErrorView(error)` is its alert.
//   Permission                     `resource:action` union from the API's schema.
//
// App shell
//   SessionNav, SessionLinks, AccessNotice, useSessionWatch
export { useSignOut, useUpdateUser, type UserUpdate } from './hooks/use-auth-actions'
export { permissionsQueryOptions, usePermissions, type Permission, type PermissionsState } from './hooks/use-permissions'
export { sessionQueryOptions, useSession } from './hooks/use-session'
export { useSessionWatch } from './hooks/use-session-watch'
export { AccessNotice } from './components/access-notice'
export { SessionLinks, SessionNav } from './components/session-nav'
export { redirectSignedIn, requirePermission, requireSession, validateLoginSearch, type LoginSearch } from './lib/guards'
export { updateUserErrorView } from './lib/errors'
export type { AuthSession, SessionUser } from './lib/session'
export { AccessPage } from './pages/access-page'
export { LoginPage } from './pages/login-page'
export { RegisterPage } from './pages/register-page'
export { SessionCheckError } from './pages/session-check-error'
