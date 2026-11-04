import { useSearch } from '@tanstack/react-router'
import { AuthLayout, type AuthFact } from '../components/auth-layout'
import { FormAlert } from '@/components/form-alert'
import { GoogleSignIn } from '../components/google-sign-in'
import { MethodDivider } from '../components/method-divider'
import { SignInForm } from '../components/sign-in-form'
import { TextLink } from '../components/text-link'
import { oauthErrorView } from '../lib/errors'
import { DEFAULT_REDIRECT, safeRedirect } from '../lib/redirect'

// What the API does on sign-in, from its configuration (auth/README.md §2). Change these with the config.
const FACTS: readonly AuthFact[] = [
  { term: 'POST /api/auth/sign-in/email', detail: 'Checks your password and sets an httpOnly session cookie for this site.' },
  { term: '5 attempts / 60 s', detail: 'Per IP address. Further attempts are refused until the minute is over.' },
  { term: 'session: 7 days', detail: 'Renewed after a day of use. Signing out ends it on the server at once.' },
]

// /login (F-05). `?redirect=` is where to go after signing in; `?error=` is a failed Google sign-in (F-02).
export function LoginPage() {
  const search = useSearch({ strict: false })
  const redirect = safeRedirect(search.redirect)
  const oauthError = typeof search.error === 'string' ? oauthErrorView(search.error) : null

  return (
    <AuthLayout title="Sign in" factsLabel="What signing in does" facts={FACTS}>
      {oauthError && (
        <div className="mb-4">
          <FormAlert error={oauthError} />
        </div>
      )}
      <SignInForm />
      <MethodDivider />
      <GoogleSignIn redirect={redirect} />
      <p className="mt-6 text-muted">
        No account yet?{' '}
        <TextLink to="/register" search={redirect === DEFAULT_REDIRECT ? {} : { redirect }}>
          Create one
        </TextLink>
      </p>
    </AuthLayout>
  )
}
