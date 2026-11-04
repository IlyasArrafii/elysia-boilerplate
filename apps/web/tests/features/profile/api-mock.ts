import { mock } from 'bun:test'

// Stand-ins for the two API clients, registered once: every profile test file imports this module first and loads the
// app afterwards with `await import()` (Bun links static imports before `mock.module` runs).

export interface ClientError {
  status: number
  statusText: string
  code?: string
  message?: string
}

type ClientResult<Data> = { data: Data; error: null } | { data: null; error: ClientError }

type FetchOptions = { onError?: (context: { response: Response }) => void }

export interface RawSession {
  user: { id: string; email: string; name: string; image: string | null; role: string }
  session: { id: string; token: string; userId: string }
}

export type UpdateUserBody = { name?: string; image?: string | null; fetchOptions?: FetchOptions }

export const getSession = mock<() => Promise<ClientResult<RawSession | null>>>()
export const updateUser = mock<(body: UpdateUserBody) => Promise<ClientResult<{ status: boolean }>>>()
const unused = async () => ({ data: null, error: { status: 500, statusText: '', code: 'NOT_IN_THIS_TEST' } })

mock.module('@/lib/auth-client', () => ({
  authClient: {
    getSession,
    updateUser,
    signIn: { email: unused, social: unused },
    signUp: { email: unused },
    signOut: unused,
  },
}))

// The app shell and `/` load these; profile never calls the Eden client itself.
const permissionsGet = async () => ({ data: { roles: ['user'], permissions: ['posts:read', 'posts:write'] }, error: null })
const healthGet = async () => ({ data: { status: 'ok', db: 'up', redis: 'up', logStore: 'up', uptime: 1 }, error: null })

mock.module('@/lib/api', () => ({ api: { me: { permissions: { get: permissionsGet } }, health: { get: healthGet } } }))

export const ok = <Data>(data: Data) => ({ data, error: null })

export const ALICE: RawSession = {
  user: { id: 'usr_alice', email: 'alice@example.test', name: 'Alice', image: null, role: 'user' },
  session: { id: 'ses_alice', token: 'secret-token-alice', userId: 'usr_alice' },
}

// A rejected call as better-fetch reports it, after running the caller's `onError` with the response.
export function rejectWith(status: number, body: Partial<ClientError>, headers: Record<string, string> = {}) {
  return async (call: { fetchOptions?: FetchOptions } = {}) => {
    call.fetchOptions?.onError?.({ response: new Response(null, { status, headers }) })
    return { data: null, error: { status, statusText: '', ...body } }
  }
}

// What the API stores after a successful update-user: the next get-session returns it.
export function acceptUpdates(session: RawSession = ALICE) {
  let stored = session
  getSession.mockImplementation(async () => ok(stored))
  updateUser.mockImplementation(async ({ name, image }) => {
    stored = { ...stored, user: { ...stored.user, ...(name !== undefined && { name }), ...(image !== undefined && { image }) } }
    return ok({ status: true })
  })
}

export function resetProfileMocks() {
  for (const fn of [getSession, updateUser]) fn.mockReset()
}
