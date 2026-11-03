import { Button, cn } from '@repo/ui'
import { ApiError } from '@/lib/api-error'
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

      {health.error && <ErrorAlert error={health.error} onRetry={() => void health.refetch()} />}
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

function ErrorAlert({ error, onRetry }: Readonly<{ error: Error; onRetry: () => void }>) {
  const code = error instanceof ApiError ? error.code : 'NETWORK_ERROR'
  return (
    <div role="alert" className="mt-6 flex items-start justify-between gap-4 border border-danger px-4 py-3">
      <div>
        <p className="font-mono text-mono text-danger">{code}</p>
        <p className="mt-1">{error instanceof ApiError ? error.message : 'The API could not be reached.'}</p>
      </div>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  )
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
