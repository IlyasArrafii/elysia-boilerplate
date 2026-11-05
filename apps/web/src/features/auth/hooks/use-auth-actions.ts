import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useCallback } from 'react'
import { ApiError, callAuthClient } from '@/lib/api-error'
import { authClient } from '@/lib/auth-client'
import { authKeys } from '../lib/keys'
import { DEFAULT_REDIRECT } from '../lib/redirect'
import { cachedUserId, recheckSession, switchIdentity, type AuthSession } from '../lib/session'
import type { SignInValues, SignUpValues } from '../lib/validation'
import { fetchSession } from './use-session'

// Every Better Auth call below passes `fetchOptions` on, so a 429's `X-Retry-After` reaches the message.

// After sign-in or sign-up, the session as the API now reads it. Null means the browser did not keep the cookie.
async function confirmedSession(): Promise<AuthSession> {
  const session = await fetchSession()
  if (!session) throw new ApiError(0, 'SESSION_NOT_KEPT', 'The browser did not keep the session cookie.', { source: 'auth' })
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
      await callAuthClient((fetchOptions) => authClient.signIn.email({ email: email.trim(), password, fetchOptions }))
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
      await callAuthClient((fetchOptions) => authClient.signUp.email({ name: name.trim(), email: email.trim(), password, fetchOptions }))
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
      await callAuthClient((fetchOptions) =>
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
      await callAuthClient((fetchOptions) => authClient.signOut({ fetchOptions }))
    },
    onSuccess: () => switchTo(null),
  })
}

// The fields POST /api/auth/update-user may change (auth/README.md §4). Email stays off; `null` removes the image.
export interface UserUpdate {
  name: string
  image: string | null
}

// Saves the signed-in user's own profile. The API answers only `{ status: true }`, so on success the accepted values
// go straight into the shared session query (every reader updates at once), then the session is re-read; the
// mutation stays pending until that re-read settles. The cache is only touched while it still holds the user who
// submitted: a response that arrives after the identity changed must not write one user's profile into another's.
// A failed re-read is not a failed save: the API already stored it, and the patched session stays shown.
// A 401 means the API saw no session: the submitter's identity is dropped here, so the session guard sends the page to
// /login even when the session cannot be re-read. Any other 401 or 403 is left to `installAuthFailureReactions`.
export function useUpdateUser() {
  const queryClient = useQueryClient()
  const switchTo = useSwitchIdentity()
  return useMutation({
    onMutate: () => cachedUserId(queryClient),
    mutationFn: async ({ name, image }: UserUpdate) => {
      await callAuthClient((fetchOptions) => authClient.updateUser({ name, image, fetchOptions }))
    },
    onSuccess: async (_result, update, submitter) => {
      queryClient.setQueryData<AuthSession | null>(authKeys.session(), (session) =>
        session && session.user.id === submitter ? { user: { ...session.user, ...update } } : session,
      )
      await recheckSession(queryClient)
    },
    onError: async (error, _update, submitter) => {
      if (!(error instanceof ApiError) || error.status !== 401) return
      if (submitter !== undefined && cachedUserId(queryClient) === submitter) await switchTo(null)
    },
  })
}
