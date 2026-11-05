import { Button } from '@repo/ui'
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router'
import { ErrorAlert } from '@/components/error-alert'
import { authErrorView, isSessionCheckError } from '../lib/errors'

// Error component of the protected layout: the session could not be checked (API or session store down), so the
// page is not shown. "Try again" re-runs the guard.
export function SessionCheckError({ error }: ErrorComponentProps) {
  const router = useRouter()
  const view = isSessionCheckError(error) ? authErrorView(error, 'session') : { code: 'PAGE_ERROR', message: 'This page could not be loaded.' }
  return (
    <main className="mx-auto max-w-5xl px-6 py-8 md:px-8">
      <h1 className="text-h1 text-primary">This page could not be loaded</h1>
      <div className="mt-6">
        <ErrorAlert error={view}>
          <Button onClick={() => void router.invalidate()}>Try again</Button>
        </ErrorAlert>
      </div>
    </main>
  )
}
