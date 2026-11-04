import { useSearch } from '@tanstack/react-router'
import { AuthLayout, type AuthFact } from '../components/auth-layout'
import { GoogleSignIn } from '../components/google-sign-in'
import { MethodDivider } from '../components/method-divider'
import { SignUpForm } from '../components/sign-up-form'
import { TextLink } from '../components/text-link'
import { DEFAULT_REDIRECT, safeRedirect } from '../lib/redirect'

// What the API does on sign-up, from its configuration (auth/README.md §2, static-roles.md §6). Change with it.
const FACTS: readonly AuthFact[] = [
  { term: 'POST /api/auth/sign-up/email', detail: 'Creates the account with the role user, stores a hash of the password and signs you in.' },
  { term: '3 sign-ups / 60 s', detail: 'Per IP address. Further sign-ups are refused until the minute is over.' },
  { term: 'GET /api/me/permissions', detail: 'Lists what your role allows. The app uses it to show or hide actions; the API checks every request itself.' },
]

// /register (F-05). Google creates an account on first use too (F-02), so it is offered here as well.
export function RegisterPage() {
  const search = useSearch({ strict: false })
  const redirect = safeRedirect(search.redirect)

  return (
    <AuthLayout title="Create an account" factsLabel="What creating an account does" facts={FACTS}>
      <SignUpForm />
      <MethodDivider />
      <GoogleSignIn redirect={redirect} />
      <p className="mt-6 text-muted">
        Already have an account?{' '}
        <TextLink to="/login" search={redirect === DEFAULT_REDIRECT ? {} : { redirect }}>
          Sign in
        </TextLink>
      </p>
    </AuthLayout>
  )
}
