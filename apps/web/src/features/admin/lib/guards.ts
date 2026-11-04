import type { QueryClient, QueryKey } from '@tanstack/react-query'
import { redirect } from '@tanstack/react-router'
import { permissionsQueryOptions, requirePermission, type AuthSession, type Permission } from '@/features/auth'
import { adminKeys } from './keys'

// What each admin screen needs (static-roles.md §6). The detail reads through `list-users` (API.md §3.1: `get-user`
// is not allowed), so it needs `user:list` as well as `user:get`.
export const SCREEN_PERMISSIONS = {
  users: ['user:list'],
  user: ['user:list', 'user:get'],
  roles: ['role:read'],
} as const satisfies Record<string, readonly Permission[]>

export type AdminScreen = keyof typeof SCREEN_PERMISSIONS

// `beforeLoad` of an admin screen, after `requireSession`. Without every permission: `/?notice=forbidden`.
export async function requireScreen(queryClient: QueryClient, session: AuthSession, screen: AdminScreen) {
  for (const permission of SCREEN_PERMISSIONS[screen]) await requirePermission(queryClient, session, permission)
}

// /admin itself: the first admin screen this visitor may open, else the forbidden notice.
export async function redirectToAdminHome(queryClient: QueryClient, session: AuthSession): Promise<never> {
  const access = await queryClient.fetchQuery(permissionsQueryOptions(session.user.id))
  const granted = (screen: AdminScreen) => SCREEN_PERMISSIONS[screen].every((p) => access.permissions.includes(p))
  if (granted('users')) throw redirect({ to: '/admin/users' })
  if (granted('roles')) throw redirect({ to: '/admin/roles' })
  // Neither screen is allowed, so this throws the auth guard's forbidden redirect: every forbidden page behaves the
  // same. The redirect after it only runs if the permissions changed in between, and the users guard re-checks.
  await requirePermission(queryClient, session, 'user:list')
  throw redirect({ to: '/admin/users' })
}

// The cached admin data the signed-in user may no longer read, given permissions the API has confirmed (status
// `ready`, never a failed or pending answer). Removing it means a later failure of the permissions query cannot bring
// it back on screen.
export function deniedAdminKeys(can: (permission: Permission) => boolean): QueryKey[] {
  const keys: QueryKey[] = []
  if (!can('user:list')) keys.push(adminKeys.users())
  else if (!can('user:get')) keys.push(adminKeys.userDetails())
  if (!can('session:list')) keys.push(adminKeys.allSessions())
  if (!can('role:read')) keys.push(adminKeys.roles())
  return keys
}
