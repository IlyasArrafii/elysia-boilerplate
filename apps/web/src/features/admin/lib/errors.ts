import { ApiError } from '@/lib/api-error'

// Admin failures with an HTTP answer are `ApiError`s whatever the client (Better Auth's admin client or Eden), so the
// app's query defaults (no retry on 4xx) and the session watcher (a 401 re-checks the session) treat them like any API
// error. A failure without an answer is an `AdminNetworkError` instead: the query defaults retry it, as they would
// not an `ApiError` (any status below 500 counts as final there).

// Local codes for failures the API sends no code for, or that the UI detects itself.
export const NETWORK_ERROR = 'NETWORK_ERROR'
export const UNKNOWN_ERROR = 'UNKNOWN_ERROR'
export const USER_NOT_FOUND = 'USER_NOT_FOUND'
// A fresh read before a change found the user no longer as the confirmation described them.
export const USER_CHANGED = 'USER_CHANGED'
// A fresh read before a revocation found the session already gone (`revoke-user-session` answers success anyway).
export const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND'

// Better Auth client errors: `{ status, statusText, code?, message? }`.
export interface AdminClientError {
  status: number
  code?: string
  message?: string
}

const STATUS_CODES: Record<number, string> = { 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND' }

export function toAdminError(error: AdminClientError): ApiError {
  const code = error.code ?? STATUS_CODES[error.status] ?? UNKNOWN_ERROR
  return new ApiError(error.status, code, error.message ?? code)
}

// `fetch` itself failed (API down, offline): there is no response to read a status or code from.
export class AdminNetworkError extends Error {
  override readonly name = 'AdminNetworkError'
  readonly code = NETWORK_ERROR

  constructor(cause: unknown) {
    super('The API could not be reached.', { cause })
  }
}

export function localError(status: number, code: string): ApiError {
  return new ApiError(status, code, code)
}

// Calls one Better Auth client method and throws its error (apps/web R12): `{ data, error }` becomes data or an
// `ApiError` carrying `status` and `code`. The client types a success body as nullable; a success without one is
// not treated as success.
export async function callAdmin<Data>(
  call: () => Promise<{ data: Data | null; error: AdminClientError | null }>,
): Promise<Data> {
  let result: Awaited<ReturnType<typeof call>>
  try {
    result = await call()
  } catch (cause) {
    throw new AdminNetworkError(cause)
  }
  if (result.error) throw toAdminError(result.error)
  if (result.data === null) throw localError(500, UNKNOWN_ERROR)
  return result.data
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

export interface AdminErrorView {
  code: string
  message: string
}

// Codes recorded from the running API (auth/README.md §5) and the admin plugin's own (1.7.15).
const MESSAGES: Record<string, string> = {
  CANNOT_CHANGE_OWN_ROLE: 'You cannot change your own role. Nothing was changed.',
  INVALID_ROLE: 'That role is not in the API’s role registry. Nothing was changed.',
  YOU_ARE_NOT_ALLOWED_TO_SET_NON_EXISTENT_VALUE: 'That role is not in the API’s role registry. Nothing was changed.',
  CANNOT_TARGET_SELF: 'You cannot ban yourself. Nothing was changed.',
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

const READS: ReadonlySet<AdminAction> = new Set(['users', 'user', 'sessions', 'roles'])

export function adminErrorView(error: unknown, action: AdminAction): AdminErrorView {
  if (error instanceof AdminNetworkError) return { code: NETWORK_ERROR, message: MESSAGES[NETWORK_ERROR] ?? FALLBACK[action] }
  if (!(error instanceof ApiError)) return { code: UNKNOWN_ERROR, message: FALLBACK[action] }
  const known = MESSAGES[error.code]
  if (known) return { code: error.code, message: known }
  if (error.status === 401) return { code: error.code, message: 'Your session has ended. Sign in again to continue.' }
  if (error.status === 403) {
    const message = READS.has(action)
      ? 'Your role does not allow this. Your access has been refreshed.'
      : 'Your role does not allow this action. Nothing was changed; your access has been refreshed.'
    return { code: error.code, message }
  }
  return { code: error.code, message: FALLBACK[action] }
}
