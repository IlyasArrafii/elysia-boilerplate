import { Button } from '@repo/ui'
import { Outlet } from '@tanstack/react-router'
import { ErrorAlert } from '@/components/error-alert'
import { usePermissions } from '@/features/auth'
import { AdminSectionNav } from '../components/admin-nav'
import { useDropDeniedAdminData } from '../hooks/use-drop-denied'

// Every /admin page: the local navigation, then the screen. While the signed-in user's permissions cannot be loaded,
// `can()` is false and every action stays hidden; this says why and offers a retry.
export function AdminLayout() {
  const access = usePermissions()
  useDropDeniedAdminData()
  return (
    <main className="mx-auto max-w-7xl px-6 py-8 md:px-8">
      <AdminSectionNav />
      {access.status === 'unavailable' && (
        <div className="mt-6">
          <ErrorAlert
            error={{ code: 'PERMISSIONS_UNAVAILABLE', message: 'Your permissions could not be loaded, so admin actions are hidden.' }}
          >
            <Button onClick={access.retry}>Try again</Button>
          </ErrorAlert>
        </div>
      )}
      <Outlet />
    </main>
  )
}
