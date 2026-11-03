import { Elysia, StatusMap } from 'elysia'
import { telemetry } from '../telemetry'
import { getRequestContext, runWithRequestContext } from './context'
import { logger } from './index'

const REQUEST_ID_HEADER = 'x-request-id'
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
// Raw paths can carry secrets (OAuth `code`, reset tokens), so a request that matched no route
// is logged under this label instead of its URL.
const UNMATCHED_ROUTE = '[unmatched]'

function resolveRequestId(header: string | null): string {
  return header !== null && REQUEST_ID_PATTERN.test(header) ? header : crypto.randomUUID()
}

// Elysia registers `GET /` of a prefixed module as `/api/posts/`; log the pattern without the slash.
function routeLabel(route: string | undefined): string {
  if (!route) return UNMATCHED_ROUTE
  return route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route
}

function statusOf(responseValue: unknown, status: number | keyof typeof StatusMap | undefined): number {
  // A handler that returns a Response (Better Auth) leaves `set.status` untouched.
  if (responseValue instanceof Response) return responseValue.status
  if (typeof status === 'number') return status
  return status === undefined ? 200 : StatusMap[status]
}

export const loggerPlugin = new Elysia({ name: 'logger' })
  // Wraps the whole request so every hook, handler, service and error handler shares one store.
  .wrap((handle, request) => () =>
    runWithRequestContext(resolveRequestId(request.headers.get(REQUEST_ID_HEADER)), () => handle(request)),
  )
  .decorate('log', logger)
  .onRequest(({ set }) => {
    const requestId = getRequestContext()?.requestId
    if (requestId !== undefined) set.headers[REQUEST_ID_HEADER] = requestId
  })
  .onAfterResponse({ as: 'global' }, ({ request, route, set, responseValue }) => {
    const context = getRequestContext()
    if (context === undefined) return

    telemetry.emit('http.request', {
      method: request.method,
      route: routeLabel(route),
      status: statusOf(responseValue, set.status),
      durationMs: Math.round((performance.now() - context.startedAt) * 10) / 10,
    })
  })
