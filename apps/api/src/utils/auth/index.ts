import { AUTH_BASE_PATH } from '@repo/auth'
import { APIError } from 'better-auth/api'
import { Elysia } from 'elysia'
import { moduleScope } from '../logger/module'
import { auth } from './auth'
import { forbiddenFor, mayCall } from './hooks'
import { USER_MUTATION_PATHS, UserMutationBusyError, userMutationLock } from './user-mutation-lock'

export { auth } from './auth'
export type { Permission } from './access'
export { userMutationLock } from './user-mutation-lock'

// The admin bodies are an ID, a role list and a ban reason. Anything bigger is refused before it can
// keep a request in the queue for the lock.
export const MAX_USER_MUTATION_BODY_BYTES = 16 * 1024

// Better Auth's own serialization of an `APIError` (better-call 1.4.4 `toResponse`): the body as
// JSON, or no body at all when the error has none (its 401).
function errorResponse(error: APIError, headers?: Record<string, string>): Response {
  const init = { status: error.statusCode, statusText: error.status.toString(), headers }
  return error.body === undefined ? new Response(null, init) : Response.json(error.body, init)
}

const busy = () =>
  errorResponse(
    new APIError('SERVICE_UNAVAILABLE', { code: 'USER_MUTATION_BUSY', message: 'Another account change is in progress, try again' }),
    { 'retry-after': '1' },
  )

// Read in full before the request queues for the lock, so a slow or endless upload never holds it.
async function readBody(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of request.body) {
    size += chunk.byteLength
    if (size > MAX_USER_MUTATION_BODY_BYTES) return null
    chunks.push(chunk)
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

// set-role, ban, unban and remove-user run under the user mutation lock (user-mutation-lock.ts).
// Callers the endpoint would refuse anyway (no session, or no role granting the endpoint's
// permission) get that answer here, without queueing, so they cannot crowd out admins. The endpoint
// still decides inside the lock: this is only the early answer.
async function handleUserMutation(request: Request, path: string): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableRefresh: true } })
  if (session === null) return errorResponse(APIError.fromStatus('UNAUTHORIZED'))
  if (!mayCall(Reflect.get(session.user, 'role'), path)) return errorResponse(forbiddenFor(path))

  const body = await readBody(request)
  if (request.body !== null && body === null) {
    return errorResponse(new APIError('PAYLOAD_TOO_LARGE', { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' }))
  }
  const buffered = new Request(request.url, { method: request.method, headers: request.headers, body })

  try {
    return await userMutationLock.run(() => auth.handler(buffered))
  } catch (err) {
    if (err instanceof UserMutationBusyError) return busy()
    throw err
  }
}

// Better Auth 1.7.15 routes only the exact path (a trailing slash is 404); a spelling that still
// reached one of these endpoints unlocked would be refused by the guard in hooks.ts.
function handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.slice(AUTH_BASE_PATH.length)
  if (USER_MUTATION_PATHS.has(path)) return handleUserMutation(request, path)
  return auth.handler(request)
}

// Better Auth's handler. The root app adds `/api`, this adds `/auth`, and together they are Better
// Auth's `basePath` `/api/auth`, so the final path is `/api/auth/*`, never `/api/api/auth/*`
// (auth/README.md §3). `parse: 'none'` leaves the body stream unread for Better Auth. An error that
// is not a Better Auth `APIError` is rethrown by Better Auth (`onAPIError.throw`) and handled by the
// API's error handler. The `auth` and `permission` macros are added here in TASK-05.
export const authPlugin = new Elysia({ name: 'auth', prefix: '/auth' })
  .use(moduleScope('auth'))
  .all('/*', ({ request }) => handle(request), { parse: 'none' })
