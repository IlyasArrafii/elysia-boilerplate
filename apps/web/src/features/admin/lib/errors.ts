import type { ErrorView } from '@/components/error-alert'
import { ApiError, callAuthClient, NETWORK_ERROR, RATE_LIMITED, UNKNOWN_ERROR, type AuthClientCall } from '@/lib/api-error'

// Admin failures are the app's one `ApiError` (src/lib/api-error.ts), like every other API failure: the query defaults
// retry only a network failure or a 5xx, and `installAuthFailureReactions` handles a 401 or 403.

// Local codes for failures the UI detects itself.
export const USER_NOT_FOUND = 'USER_NOT_FOUND'
// A fresh read before a change found the user no longer as the confirmation described them.
export const USER_CHANGED = 'USER_CHANGED'
// A fresh read before a revocation found the session already gone (`revoke-user-session` answers success anyway).
export const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND'

export function localError(status: number, code: string): ApiError {
  return new ApiError(status, code, code)
}

// Calls one Better Auth admin client method and throws its failure (apps/web R12). The client types a success body as
// nullable; a success without one is not treated as success.
export async function callAdmin<Data>(send: AuthClientCall<Data>): Promise<Data> {
  const data = await callAuthClient(send)
  if (data === null) throw localError(500, UNKNOWN_ERROR)
  return data
}

export type AdminAction =
  | 'users'
  | 'user'
  | 'sessions'
  | 'roles'
  | 'set-role'
  | 'ban'
  | 'unban'
  | 'revoke-session'
  | 'revoke-sessions'

// Codes recorded from the running API (auth/README.md §5) and the admin plugin's own (1.7.15).
const MESSAGES: Record<string, string> = {
  CANNOT_CHANGE_OWN_ROLE: 'You cannot change your own role. Nothing was changed.',
  INVALID_ROLE: 'That role is not in the API’s role registry. Nothing was changed.',
  YOU_ARE_NOT_ALLOWED_TO_SET_NON_EXISTENT_VALUE: 'That role is not in the API’s role registry. Nothing was changed.',
  YOU_CANNOT_BAN_YOURSELF: 'You cannot ban yourself. Nothing was changed.',
  LAST_SUPER_ADMIN: 'At least one usable super_admin must remain, so the API refused this change. Nothing was changed.',
  USER_MUTATION_BUSY: 'Another account change is in progress. Nothing was changed; try again in a moment.',
  PAYLOAD_TOO_LARGE: 'The ban reason is too long for the API. Shorten it and try again.',
  INVALID_USER_ID: 'The API did not accept this user ID. Nothing was changed.',
  [USER_NOT_FOUND]: 'This user no longer exists.',
  [USER_CHANGED]: 'This user changed since the page loaded. Nothing was changed; review the current values and try again.',
  [SESSION_NOT_FOUND]: 'This session had already ended. The list has been refreshed.',
  [NETWORK_ERROR]: 'The API could not be reached. Check your connection and try again.',
}

const FALLBACK: Record<AdminAction, string> = {
  users: 'The users could not be loaded. Try again.',
  user: 'This user could not be loaded. Try again.',
  sessions: 'The sessions could not be loaded. Try again.',
  roles: 'The role catalogue could not be loaded. Try again.',
  'set-role': 'The role could not be changed. Try again.',
  ban: 'The user could not be banned. Try again.',
  unban: 'The user could not be unbanned. Try again.',
  'revoke-session': 'The session could not be revoked. Try again.',
  'revoke-sessions': 'The sessions could not be revoked. Try again.',
}

// `CANNOT_TARGET_SELF` is the API's answer to any admin change aimed at the caller's own account (ban, role change,
// removal), so the message follows the action; an action without its own wording gets the neutral one.
const SELF_TARGET_MESSAGES: Partial<Record<AdminAction, string>> = {
  ban: 'You cannot ban yourself. Nothing was changed.',
  'set-role': 'You cannot change your own role. Nothing was changed.',
}
const SELF_TARGET_FALLBACK = 'You cannot do this to your own account. Nothing was changed.'

const READS: ReadonlySet<AdminAction> = new Set(['users', 'user', 'sessions', 'roles'])

// The admin alert names a Better Auth failure that came without a code by its status, a 429 included (no own code).
const STATUS_CODES: Record<number, string> = { 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND' }

function shownCode(error: ApiError): string {
  if (error.source !== 'auth' || (error.code !== UNKNOWN_ERROR && error.code !== RATE_LIMITED)) return error.code
  return STATUS_CODES[error.status] ?? UNKNOWN_ERROR
}

export function adminErrorView(error: unknown, action: AdminAction): ErrorView {
  if (!(error instanceof ApiError)) return { code: UNKNOWN_ERROR, message: FALLBACK[action] }
  if (error.network) return { code: NETWORK_ERROR, message: MESSAGES[NETWORK_ERROR] ?? FALLBACK[action] }
  const code = shownCode(error)
  if (error.code === 'CANNOT_TARGET_SELF') return { code: error.code, message: SELF_TARGET_MESSAGES[action] ?? SELF_TARGET_FALLBACK }
  const known = MESSAGES[error.code]
  if (known) return { code, message: known }
  if (error.status === 401) return { code, message: 'Your session has ended. Sign in again to continue.' }
  if (error.status === 403) {
    const message = READS.has(action)
      ? 'Your role does not allow this. Your access has been refreshed.'
      : 'Your role does not allow this action. Nothing was changed; your access has been refreshed.'
    return { code, message }
  }
  return { code, message: FALLBACK[action] }
}
