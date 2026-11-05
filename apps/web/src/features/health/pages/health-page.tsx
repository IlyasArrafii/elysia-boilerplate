import { Button, cn } from '@repo/ui'
import { ErrorAlert, type ErrorView } from '@/components/error-alert'
import { ApiError, NETWORK_ERROR } from '@/lib/api-error'
import { useHealth } from '../hooks/use-health'

type DependencyState = 'up' | 'down' | 'disabled'

const DEPENDENCIES = [
  { key: 'db', label: 'PostgreSQL' },
  { key: 'redis', label: 'Redis' },
  { key: 'logStore', label: 'Log store' },
] as const

// The state is always written out; colour only reinforces it (DESIGN.md §12).
const STATE_CLASS: Record<DependencyState, string> = {
  up: 'text-success',
  down: 'text-danger',
  disabled: 'text-muted',
}

export function HealthPage() {
  const health = useHealth()

  return (
    <main className="mx-auto max-w-3xl px-6 py-8 md:px-8">
      <header className="flex items-center justify-between gap-4 border-b border-border pb-4">
        <h1 className="text-h1 text-primary">API status</h1>
        <Button onClick={() => void health.refetch()} disabled={health.isFetching}>
          {health.isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </header>

      {health.error && (
        <div className="mt-6">
          <ErrorAlert error={healthErrorView(health.error)}>
            <Button onClick={() => void health.refetch()}>Try again</Button>
          </ErrorAlert>
        </div>
      )}
      {health.isPending && <StatusSkeleton />}
      {health.data && (
        <section aria-labelledby="dependencies-heading" className="mt-6">
          <h2 id="dependencies-heading" className="text-h2">
            Dependencies
          </h2>
          <table className="mt-3 w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border text-caption text-muted">
                <th scope="col" className="py-2 font-medium">
                  Service
                </th>
                <th scope="col" className="py-2 font-medium">
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {DEPENDENCIES.map(({ key, label }) => (
                <tr key={key} className="border-b border-border">
                  <td className="py-2">{label}</td>
                  <td className={cn('py-2 font-mono text-mono', STATE_CLASS[health.data[key]])}>{health.data[key]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-caption text-muted">
            Status <span className="font-mono text-mono text-fg">{health.data.status}</span> · uptime{' '}
            <span className="font-mono text-mono text-fg">{health.data.uptime}s</span>
          </p>
        </section>
      )}
    </main>
  )
}

// The status page is a diagnostic: it shows the API's own message.
function healthErrorView(error: Error): ErrorView {
  if (error instanceof ApiError) return { code: error.code, message: error.message }
  return { code: NETWORK_ERROR, message: 'The API could not be reached.' }
}

function StatusSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading API status" className="mt-6 space-y-3">
      {DEPENDENCIES.map(({ key }) => (
        <div key={key} className="h-9 animate-pulse bg-hover" />
      ))}
    </div>
  )
}
