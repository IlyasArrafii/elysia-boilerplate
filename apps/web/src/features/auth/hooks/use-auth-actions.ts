import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import { authClient } from '@/lib/auth-client'
import { AuthError, networkError, parseRetryAfter, toAuthError, type AuthClientError } from '../lib/errors'
import { DEFAULT_REDIRECT } from '../lib/redirect'
import { switchIdentity, type AuthSession } from '../lib/session'
import type { SignInValues, SignUpValues } from '../lib/validation'
import { fetchSession } from './use-session'

type ClientResult = { error: AuthClientError | null }

// Runs one Better Auth client call and turns every failure into an AuthError. `fetch` throwing means no response
// at all (offline, API down); an HTTP error comes back as `result.error`, with `X-Retry-After` on a 429.
async function call<Result extends ClientResult>(
  send: (fetchOptions: { onError: (context: { response: Response }) => void }) => Promise<Result>,
): Promise<Result> {
  let retryAfter: number | undefined
  let result: Result
  try {
    result = await send({
      onError: ({ response }) => {
        retryAfter = parseRetryAfter(response.headers.get('x-retry-after'))
      },
    })
  } catch (cause) {
    throw networkError(cause)
  }
  if (result.error) throw toAuthError(result.error, retryAfter)
  return result
}

// After sign-in or sign-up, the session as the API now reads it. Null means the browser did not keep the cookie.
async function confirmedSession(): Promise<AuthSession> {
  const session = await fetchSession()
  if (!session) throw new AuthError(0, 'SESSION_NOT_KEPT', 'The browser did not keep the session cookie.')
  return session
}

function useSwitchIdentity() {
  const queryClient = useQueryClient()
  const router = useRouter()
  return useCallback((session: AuthSession | null) => switchIdentity(queryClient, router, session), [queryClient, router])
}

// The mutation stays pending until the router has moved on, so the submit button cannot fire again meanwhile.
export function useSignIn() {
  const switchTo = useSwitchIdentity()
  return useMutation({
    mutationFn: async ({ email, password }: SignInValues) => {
      await call((fetchOptions) => authClient.signIn.email({ email: email.trim(), password, fetchOptions }))
      return confirmedSession()
    },
    onSuccess: switchTo,
  })
}

// Better Auth signs the new account in straight away (no email verification yet, auth/README.md §2).
export function useSignUp() {
  const switchTo = useSwitchIdentity()
  return useMutation({
    mutationFn: async ({ name, email, password }: SignUpValues) => {
      await call((fetchOptions) => authClient.signUp.email({ name: name.trim(), email: email.trim(), password, fetchOptions }))
      return confirmedSession()
    },
    onSuccess: switchTo,
  })
}

// Where Better Auth sends the browser back after a failed Google sign-in; it appends `error=<code>`.
export function loginPath(redirect: string): string {
  return redirect === DEFAULT_REDIRECT ? '/login' : `/login?${new URLSearchParams({ redirect })}`
}

// Success means the browser is on its way to Google: Better Auth's client follows the returned URL itself.
// Both URLs are paths on this origin; the API refuses any other (`trustedOrigins`).
export function useGoogleSignIn() {
  return useMutation({
    mutationFn: async (redirect: string) => {
      await call((fetchOptions) =>
        authClient.signIn.social({ provider: 'google', callbackURL: redirect, errorCallbackURL: loginPath(redirect), fetchOptions }),
      )
    },
  })
}

// The API deletes the session row; only then is the local identity dropped.
export function useSignOut() {
  const switchTo = useSwitchIdentity()
  return useMutation({
    mutationFn: async () => {
      await call((fetchOptions) => authClient.signOut({ fetchOptions }))
    },
    onSuccess: () => switchTo(null),
  })
}
