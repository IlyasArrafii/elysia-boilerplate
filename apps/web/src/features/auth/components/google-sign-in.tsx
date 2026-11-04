import { Button } from '@repo/ui'
import { useEffect, useRef } from 'react'
import { useGoogleSignIn } from '../hooks/use-auth-actions'
import { authErrorView } from '../lib/errors'
import { FormAlert } from './form-alert'

// Google sign-in (F-02). Failures that happen at Google come back as `?error=` on /login, handled by the page;
// this only shows a failure to start (provider not configured, API unreachable, rate limited).
export function GoogleSignIn({ redirect }: Readonly<{ redirect: string }>) {
  const google = useGoogleSignIn()
  const inFlight = useRef(false)
  const leaving = google.isPending || google.isSuccess
  const { reset } = google

  // Coming back from Google with the Back button can restore this page from the back/forward cache, still
  // "leaving": make the button usable again.
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      inFlight.current = false
      reset()
    }
    window.addEventListener('pageshow', restore)
    return () => window.removeEventListener('pageshow', restore)
  }, [reset])

  async function start() {
    if (inFlight.current) return
    inFlight.current = true
    try {
      await google.mutateAsync(redirect)
    } catch {
      inFlight.current = false
    }
  }

  return (
    <div className="grid gap-3">
      {google.error && <FormAlert error={authErrorView(google.error, 'google')} />}
      <Button variant="secondary" className="w-full" disabled={leaving} onClick={() => void start()}>
        {leaving ? 'Opening Google…' : 'Continue with Google'}
      </Button>
    </div>
  )
}
