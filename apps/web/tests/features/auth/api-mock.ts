import { mock } from 'bun:test'
import type { AuthClientErrorBody as ClientError } from '../../helpers/api-results'

// Stand-ins for the two API clients, registered once: every auth test file imports this module first and loads the
// feature afterwards with `await import()` (Bun links static imports before `mock.module` runs).

export interface SessionUserData {
  id: string
  email: string
  name: string
  image?: string | null
}

type ClientResult<Data> = { data: Data; error: null } | { data: null; error: ClientError }

type FetchOptions = { onError?: (context: { response: Response }) => void }

export type RawSession = { user: SessionUserData & { role?: string }; session: { id: string; token: string; userId: string } }

export const getSession = mock<() => Promise<ClientResult<RawSession | null>>>()
export const signInEmail = mock<(body: { email: string; password: string; fetchOptions?: FetchOptions }) => Promise<ClientResult<unknown>>>()
export const signUpEmail =
  mock<(body: { name: string; email: string; password: string; fetchOptions?: FetchOptions }) => Promise<ClientResult<unknown>>>()
export const signInSocial =
  mock<(body: { provider: string; callbackURL: string; errorCallbackURL: string; fetchOptions?: FetchOptions }) => Promise<ClientResult<unknown>>>()
export const signOut = mock<(body?: { fetchOptions?: FetchOptions }) => Promise<ClientResult<unknown>>>()

mock.module('@/lib/auth-client', () => ({
  authClient: {
    getSession,
    signIn: { email: signInEmail, social: signInSocial },
    signUp: { email: signUpEmail },
    signOut,
  },
}))

export type PermissionsBody = { roles: string[]; permissions: string[] }
export type PermissionsResult =
  | { data: PermissionsBody; error: null }
  | { data: null; error: { status: number; value: unknown } }

export const permissionsGet = mock<() => Promise<PermissionsResult>>()

// `health` answers too, because the real route tree mounts the status page at `/`.
const healthGet = async () => ({ data: { status: 'ok', db: 'up', redis: 'up', logStore: 'up', uptime: 1 }, error: null })

mock.module('@/lib/api', () => ({ api: { me: { permissions: { get: permissionsGet } }, health: { get: healthGet } } }))

export { apiFailed, authFailed as failed, ok, rejectWith } from '../../helpers/api-results'

export const ALICE: RawSession = {
  user: { id: 'usr_alice', email: 'alice@example.test', name: 'Alice', image: null, role: 'user' },
  session: { id: 'ses_alice', token: 'secret-token-alice', userId: 'usr_alice' },
}

export const BOB: RawSession = {
  user: { id: 'usr_bob', email: 'bob@example.test', name: 'Bob', image: null, role: 'admin' },
  session: { id: 'ses_bob', token: 'secret-token-bob', userId: 'usr_bob' },
}

export const USER_ACCESS: PermissionsBody = { roles: ['user'], permissions: ['posts:read', 'posts:write'] }

export function resetAuthMocks() {
  for (const fn of [getSession, signInEmail, signUpEmail, signInSocial, signOut, permissionsGet]) fn.mockReset()
}
