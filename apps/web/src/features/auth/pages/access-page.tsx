import { Button } from '@repo/ui'
import { FormAlert } from '../components/form-alert'
import { usePermissions } from '../hooks/use-permissions'
import { useSession } from '../hooks/use-session'
import { accessErrorView } from '../lib/errors'

// /access, behind the session guard: the signed-in user's roles and permissions as GET /api/me/permissions reports
// them. It is what `can()` reads, so this page shows exactly what the app will show or hide.
export function AccessPage() {
  const session = useSession()
  const access = usePermissions()

  return (
    <main className="mx-auto max-w-5xl px-6 py-8 md:px-8">
      <header className="border-b border-border pb-4">
        <h1 className="text-h1 text-primary">Your access</h1>
        {session.data && (
          <p className="mt-2 text-muted">
            Signed in as <span className="font-mono text-mono break-all text-fg">{session.data.user.email}</span>
          </p>
        )}
      </header>

      {access.status === 'unavailable' && (
        <div className="mt-6">
          <FormAlert error={accessErrorView(access.error)}>
            <Button onClick={access.retry}>Try again</Button>
          </FormAlert>
        </div>
      )}
      {access.status === 'loading' && <AccessSkeleton />}
      {access.status === 'ready' && (
        <div className="mt-6 grid gap-8 lg:grid-cols-12 lg:gap-4">
          <section aria-labelledby="roles-heading" className="lg:col-span-4">
            <h2 id="roles-heading" className="text-h2">
              Roles
            </h2>
            <ul className="mt-3 divide-y divide-border border-y border-border">
              {access.roles.map((role) => (
                <li key={role} className="py-2 font-mono text-mono">
                  {role}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="permissions-heading" className="lg:col-span-7 lg:col-start-6">
            <h2 id="permissions-heading" className="text-h2">
              Permissions
            </h2>
            {access.permissions.length === 0 ? (
              <p className="mt-3 border-y border-border py-3 text-muted">
                Your roles grant no permissions. Pages that only need a session still work.
              </p>
            ) : (
              <ul className="mt-3 grid divide-y divide-border border-y border-border sm:grid-cols-2 sm:divide-y-0">
                {access.permissions.map((permission) => (
                  <li key={permission} className="py-2 font-mono text-mono sm:border-b sm:border-border">
                    {permission}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-caption text-muted">
              The API checks every request against your role. This list only decides what the app shows.
            </p>
          </section>
        </div>
      )}
    </main>
  )
}

function AccessSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your access" className="mt-6 grid gap-3">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="h-9 animate-pulse bg-hover" />
      ))}
    </div>
  )
}
