import { NavLink } from '@/components/nav-link'
import { usePermissions } from '@/features/auth'
import { SCREEN_PERMISSIONS, type AdminScreen } from '../lib/guards'

// Which admin screens the signed-in user may open, from the compiled permissions (never role names, apps/web R17).
export function useAdminScreens() {
  const access = usePermissions()
  const allowed = (screen: AdminScreen) => SCREEN_PERMISSIONS[screen].every((permission) => access.can(permission))
  return { users: allowed('users'), user: allowed('user'), roles: allowed('roles') }
}

// The header entry for the app shell: one "Admin" link, only for someone who may open an admin screen (DESIGN.md §11:
// forbidden pages are not shown in navigation). Renders nothing while permissions load or are unavailable.
export function AdminNav() {
  const screens = useAdminScreens()
  if (!screens.users && !screens.roles) return null
  return <NavLink to="/admin">Admin</NavLink>
}

// Local navigation between the admin screens, on every admin page.
export function AdminSectionNav() {
  const screens = useAdminScreens()
  if (!screens.users && !screens.roles) return null
  return (
    <nav aria-label="Admin sections" className="flex flex-wrap items-center gap-1 border-b border-border">
      {screens.users && <NavLink to="/admin/users">User list</NavLink>}
      {screens.roles && <NavLink to="/admin/roles">Role catalogue</NavLink>}
    </nav>
  )
}
