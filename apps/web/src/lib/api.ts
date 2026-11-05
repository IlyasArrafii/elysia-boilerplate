import { treaty } from '@elysiajs/eden'
import type { App } from '@repo/api'
import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import { apiOrigin } from './api-origin'

// During SSR the API sees a server-to-server call, so the visitor's session cookie is forwarded by hand
// (apps/web R13). In the browser the cookie travels on its own (same origin).
const forwardedHeaders = createIsomorphicFn()
  .server((): Record<string, string> => {
    const cookie = getRequestHeader('cookie')
    return cookie ? { cookie } : {}
  })
  .client((): Record<string, string> => ({}))

// The one Eden client (DEC-018). Calls read like the API paths: `api.health.get()` → GET /api/health.
// Only hooks in `features/<feature>/hooks/` call it (R9); they unwrap results with `unwrap()` from `./api-error`.
// Redirects are never followed, as in the auth cookie bridge: a followed redirect would resend the forwarded cookie to
// wherever it points. The API modules never redirect, so Eden reports the 3xx as an error and `unwrap()` throws it.
export const api = treaty<App>(apiOrigin(), { headers: () => forwardedHeaders(), fetch: { redirect: 'manual' } }).api
