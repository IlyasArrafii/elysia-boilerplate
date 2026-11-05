import type { ErrorView } from '@/components/error-alert'
import { ApiError, NETWORK_ERROR, RATE_LIMITED, UNKNOWN_ERROR } from '@/lib/api-error'

// Better Auth's codes on /api/auth/*, as recorded from the running API (auth/README.md §5). Failures arrive as the
// app's one `ApiError` (src/lib/api-error.ts); their messages are mapped from `error.code` here and nowhere else
// (apps/web R16).

export type AuthAction = 'sign-in' | 'sign-up' | 'sign-out' | 'google' | 'session' | 'update-user'

const MESSAGES: Record<string, string> = {
  BANNED_USER: 'This account is banned. Contact an administrator of this app.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'An account with this email already exists. Sign in instead.',
  PASSWORD_TOO_SHORT: 'The password is too short for this server.',
  PASSWORD_TOO_LONG: 'The password is too long for this server.',
  INVALID_EMAIL: 'Enter a valid email address.',
  PROVIDER_NOT_FOUND: 'Google sign-in is not configured on this server.',
  FAILED_TO_GET_SESSION: 'Your session could not be checked. Try again.',
  [NETWORK_ERROR]: 'The API could not be reached. Check your connection and try again.',
}

const FALLBACK: Record<AuthAction, string> = {
  'sign-in': 'Sign-in failed. Try again.',
  'sign-up': 'The account could not be created. Try again.',
  'sign-out': 'Sign-out failed. Try again.',
  google: 'Google sign-in could not start. Try again.',
  session: 'Your session could not be checked. Try again.',
  'update-user': 'Your profile could not be saved. Try again.',
}

// One wording for every rejected sign-in, so the form never tells whether an email has an account (R16).
export const SIGN_IN_FAILED = 'Email or password is incorrect.'

// The session ended between loading a page and saving it (signed out elsewhere, expired, revoked).
export const SESSION_ENDED = 'Your session has ended. Sign in again to save your changes.'

export function authErrorView(error: unknown, action: AuthAction): ErrorView {
  if (!(error instanceof ApiError)) return { code: UNKNOWN_ERROR, message: FALLBACK[action] }
  if (error.code === RATE_LIMITED) {
    const wait = error.retryAfter ? `in ${error.retryAfter} seconds` : 'in a minute'
    return { code: RATE_LIMITED, message: `Too many attempts. Try again ${wait}.` }
  }
  if (action === 'sign-in' && error.status === 401) return { code: error.code, message: SIGN_IN_FAILED }
  if (action === 'update-user' && error.status === 401) return { code: error.code, message: SESSION_ENDED }
  return { code: error.code, message: MESSAGES[error.code] ?? FALLBACK[action] }
}

// The alert for a failed profile save (`useUpdateUser`).
export function updateUserErrorView(error: unknown): ErrorView {
  return authErrorView(error, 'update-user')
}

export type AuthField = 'name' | 'email' | 'password'

// Codes about one input. The form shows them on that field rather than above the form (apps/web R22). A rejected
// sign-in (401) is never one of them: it stays one generic message at form level (R16).
const FIELD_OF_CODE: Record<string, AuthField> = {
  INVALID_EMAIL: 'email',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'email',
  PASSWORD_TOO_SHORT: 'password',
  PASSWORD_TOO_LONG: 'password',
}

export function authErrorField(error: unknown): AuthField | undefined {
  if (!(error instanceof ApiError) || error.status === 401) return undefined
  return FIELD_OF_CODE[error.code]
}

// Codes Better Auth 1.7.15 puts in `?error=` when it sends the browser back from Google (`errorCallbackURL`).
const OAUTH_MESSAGES: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled. No account was created.',
  state_mismatch: 'The Google sign-in expired or did not match this browser. Start again.',
  state_not_found: 'The Google sign-in expired or did not match this browser. Start again.',
  please_restart_the_process: 'The Google sign-in expired or did not match this browser. Start again.',
  account_not_linked: 'An account with this email exists but could not be linked to Google. Sign in with your password.',
  unable_to_link_account: 'An account with this email exists but could not be linked to Google. Sign in with your password.',
  email_not_found: 'Google did not share an email address, so no account was created.',
  email_not_verified: 'Your Google email address is not verified, so no account was created.',
  signup_disabled: 'New accounts cannot be created with Google on this server.',
  banned: 'This account is banned. Contact an administrator of this app.',
}

// Codes come from the URL, so only plain lowercase identifiers are shown; anything else becomes `oauth_error`.
const OAUTH_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

export function oauthErrorView(code: string): ErrorView {
  const safeCode = OAUTH_CODE_PATTERN.test(code) ? code : 'oauth_error'
  return { code: safeCode, message: OAUTH_MESSAGES[safeCode] ?? 'Google sign-in failed. Try again.' }
}

// GET /api/me/permissions failed (an `api` error from the Eden client), or the session check before it did (an
// `auth` error from the Better Auth client).
export function accessErrorView(error: unknown): ErrorView {
  if (isSessionCheckError(error)) return authErrorView(error, 'session')
  if (error instanceof ApiError && !error.network) return { code: error.code, message: 'Your permissions could not be loaded. Try again.' }
  return { code: NETWORK_ERROR, message: MESSAGES[NETWORK_ERROR] ?? FALLBACK.session }
}

// A failure of the Better Auth client, which is the session check wherever a page guard or `usePermissions` reports
// one. Failures of the API modules (permissions, page data) are not.
export function isSessionCheckError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.source === 'auth'
}
