// Public interface of the admin feature (apps/web R4, R5). Everything else in this folder is internal.
//
// Route files (all under routes/_authed/, so `context.session` exists)
//   AdminLayout                    /admin layout: local navigation between the admin screens, then the screen.
//   redirectToAdminHome            `beforeLoad` of /admin: the first screen this visitor may open, else the forbidden
//                                  notice.
//   requireScreen                  `beforeLoad` of a screen: `requireScreen(context.queryClient, context.session,
//                                  'users' | 'user' | 'roles')`, every permission that screen needs.
//   UsersPage, validateUsersSearch /admin/users (list, `?page=&q=`); also the master beside the detail.
//   usersQueryOptions              The list for a loader (`loaderDeps` on the search).
//   UserDetailPage                 /admin/users/$userId; `userQueryOptions(userId)` for its loader.
//   RolesPage, rolesQueryOptions   /admin/roles, the role catalogue.
//
// App shell
//   AdminNav                       Header link to /admin, shown only with a permission an admin screen needs.
export { AdminNav } from './components/admin-nav'
export { rolesQueryOptions } from './hooks/use-roles'
export { userQueryOptions, usersQueryOptions } from './hooks/use-users'
export { redirectToAdminHome, requireScreen } from './lib/guards'
export { validateUsersSearch } from './lib/users'
export { AdminLayout } from './pages/admin-layout'
export { RolesPage } from './pages/roles-page'
export { UserDetailPage } from './pages/user-detail-page'
export { UsersPage } from './pages/users-page'
