import { Button } from '@repo/ui'
import { ErrorAlert } from '@/components/error-alert'
import { usePermissions } from '@/features/auth'
import { AccessFallback } from '../components/admin-alert'
import { useAdminScreens } from '../components/admin-nav'
import { useRoles, type CatalogueRole } from '../hooks/use-roles'
import { adminErrorView } from '../lib/errors'

// /admin/roles: the code-defined catalogue (DESIGN.md §6: role list + permission table, read-only). Rendered only once
// `role:read` is confirmed.
export function RolesPage() {
  const access = usePermissions()
  const screens = useAdminScreens()
  const roles = useRoles(screens.roles)

  return (
    <section aria-labelledby="roles-heading" className="mt-6">
      <h1 id="roles-heading" className="text-h1 text-primary">
        Roles
      </h1>
      <p className="mt-2 text-muted">
        Roles are defined in code and cannot be edited here. This is what the API checks for each role.
      </p>

      {!screens.roles ? (
        <div className="mt-6">
          <AccessFallback status={access.status}>Your role no longer allows the role catalogue.</AccessFallback>
        </div>
      ) : (
        <>
          {roles.isPending && (
            <div aria-busy="true" aria-label="Loading roles" className="mt-6 grid gap-1">
              {[0, 1, 2, 3, 4].map((row) => (
                <div key={row} className="h-9 animate-pulse bg-hover" />
              ))}
            </div>
          )}
          {roles.isError && (
            <div className="mt-6">
              <ErrorAlert error={adminErrorView(roles.error, 'roles')}>
                <Button onClick={() => void roles.refetch()}>Try again</Button>
              </ErrorAlert>
            </div>
          )}
          {roles.data?.items.length === 0 && <p className="mt-6 border-y border-border py-3 text-muted">The API lists no roles.</p>}
          {roles.data && roles.data.items.length > 0 && <Catalogue roles={roles.data.items} />}
        </>
      )}
    </section>
  )
}

function Catalogue({ roles }: Readonly<{ roles: readonly CatalogueRole[] }>) {
  const permissions = [...new Set(roles.flatMap((role) => role.permissions))].sort()

  return (
    <div className="mt-6 grid gap-8 lg:grid-cols-12 lg:gap-4">
      <section aria-labelledby="role-list-heading" className="lg:col-span-4">
        <h2 id="role-list-heading" className="text-h2">
          Role list
        </h2>
        <ul className="mt-3 divide-y divide-border border-y border-border">
          {roles.map((role) => (
            <li key={role.role} className="py-3">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-semibold">{role.label}</span>
                <span className="font-mono text-mono text-muted">{role.role}</span>
              </p>
              <p className="mt-1">{role.description}</p>
              <p className="mt-1 text-caption text-muted">
                {role.permissions.length} {role.permissions.length === 1 ? 'permission' : 'permissions'}
              </p>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="matrix-heading" className="min-w-0 lg:col-span-8">
        <h2 id="matrix-heading" className="text-h2">
          Permissions by role
        </h2>
        {permissions.length === 0 ? (
          <p className="mt-3 border-y border-border py-3 text-muted">No role grants any permission.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Which role holds each permission</caption>
              <thead>
                <tr className="border-b border-border text-caption text-muted">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Permission
                  </th>
                  {roles.map((role) => (
                    <th key={role.role} scope="col" className="py-2 pr-3 font-mono text-mono font-medium">
                      {role.role}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {permissions.map((permission) => (
                  <tr key={permission} className="border-b border-border">
                    <th scope="row" className="py-2 pr-3 font-mono text-mono font-normal whitespace-nowrap">
                      {permission}
                    </th>
                    {roles.map((role) => (
                      <td key={role.role} className="py-2 pr-3">
                        <Grant granted={role.permissions.includes(permission)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

// Text and glyph, never colour alone (DESIGN.md §12).
function Grant({ granted }: Readonly<{ granted: boolean }>) {
  return granted ? (
    <span className="text-success">
      <span aria-hidden="true">✓</span>
      <span className="sr-only">Granted</span>
    </span>
  ) : (
    <span className="text-muted">
      <span aria-hidden="true">—</span>
      <span className="sr-only">Not granted</span>
    </span>
  )
}
