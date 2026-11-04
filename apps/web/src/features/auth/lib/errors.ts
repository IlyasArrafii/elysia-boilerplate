import type { ErrorView } from '@/components/form-alert'
import { ApiError } from '@/lib/api-error'

// Better Auth's codes on /api/auth/*, as recorded from the running API (auth/README.md §5). Messages are mapped
// from `error.code` here and nowhere else (apps/web R16).

// Local codes for failures Better Auth sends no code for.
export const NETWORK_ERROR = 'NETWORK_ERROR'
export const RATE_LIMITED = 'RATE_LIMITED'
export const UNKNOWN_ERROR = 'UNKNOWN_ERROR'

export class AuthError extends Error {
  override readonly name = 'AuthError'

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    // Seconds from `X-Retry-After` on a 429.
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

// Better Auth client errors: `{ status, statusText, code?, message? }`.
export interface AuthClientError {
  status: number
  code?: string
  message?: string
}

export function toAuthError(error: AuthClientError, retryAfter?: number): AuthError {
  // A 429 carries no code, only `{ message }` and the header (auth/README.md §5).
  const code = error.status === 429 ? RATE_LIMITED : (error.code ?? UNKNOWN_ERROR)
  return new AuthError(error.status, code, error.message ?? code, retryAfter)
}

// `fetch` itself failed (API down, offline): there is no response to read a code from.
export function networkError(cause: unknown): AuthError {
  const error = new AuthError(0, NETWORK_ERROR, 'The API could not be reached.')
  error.cause = cause
  return error
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  return Number.isInteger(seconds) && seconds > 0 ? seconds : undefined
}

export type AuthAction = 'sign-in' | 'sign-up' | 'sign-out' | 'google' | 'session' | 'update-user'

export type AuthErrorView = ErrorView

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

export function authErrorView(error: unknown, action: AuthAction): AuthErrorView {
  if (!(error instanceof AuthError)) return { code: UNKNOWN_ERROR, message: FALLBACK[action] }
  if (error.code === RATE_LIMITED) {
    const wait = error.retryAfter ? `in ${error.retryAfter} seconds` : 'in a minute'
    return { code: RATE_LIMITED, message: `Too many attempts. Try again ${wait}.` }
  }
  if (action === 'sign-in' && error.status === 401) return { code: error.code, message: SIGN_IN_FAILED }
  if (action === 'update-user' && error.status === 401) return { code: error.code, message: SESSION_ENDED }
  return { code: error.code, message: MESSAGES[error.code] ?? FALLBACK[action] }
}

// The alert for a failed profile save (`useUpdateUser`).
export function updateUserErrorView(error: unknown): AuthErrorView {
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
  if (!(error instanceof AuthError) || error.status === 401) return undefined
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

export function oauthErrorView(code: string): AuthErrorView {
  const safeCode = OAUTH_CODE_PATTERN.test(code) ? code : 'oauth_error'
  return { code: safeCode, message: OAUTH_MESSAGES[safeCode] ?? 'Google sign-in failed. Try again.' }
}

// GET /api/me/permissions failed (an ApiError from the Eden client), or the session check before it did.
export function accessErrorView(error: unknown): AuthErrorView {
  if (error instanceof AuthError) return authErrorView(error, 'session')
  if (error instanceof ApiError) return { code: error.code, message: 'Your permissions could not be loaded. Try again.' }
  return { code: NETWORK_ERROR, message: MESSAGES[NETWORK_ERROR] ?? FALLBACK.session }
}
