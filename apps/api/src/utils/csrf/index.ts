import { AUTH_BASE_PATH } from '@repo/auth'
import { Elysia, status } from 'elysia'
import { env } from '../../env'
import { telemetry } from '../telemetry'

export const CSRF_REJECTED = { code: 'CSRF_REJECTED', message: 'Cross-site request refused' } as const
export const UNSUPPORTED_MEDIA_TYPE = {
  code: 'UNSUPPORTED_MEDIA_TYPE',
  message: 'The request body must be application/json',
} as const

export type CsrfRejectReason = 'cross-site' | 'same-site' | 'foreign-origin' | 'missing-origin'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
// `none` is a request the user started (typed URL, bookmark), never one a page made.
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none'])
// Better Auth checks the origin of its own requests (`trustedOrigins`); that mount is left to it.
const AUTH_PATH_PREFIX = `${AUTH_BASE_PATH}/`

// `env.WEB_URL` is already an origin (env.ts `readOrigin`), the one Better Auth trusts.
function rejectReason(headers: Headers): CsrfRejectReason | undefined {
  const site = headers.get('sec-fetch-site')
  if (site !== null) {
    if (ALLOWED_FETCH_SITES.has(site)) return undefined
    return site === 'same-site' ? 'same-site' : 'cross-site'
  }

  const origin = headers.get('origin')
  if (origin !== null) return origin === env.WEB_URL ? undefined : 'foreign-origin'
  // Neither header: an old browser or a non-browser client. Without a cookie it cannot ride a
  // session, so it gets the route's usual 401; with one it is refused.
  return headers.has('cookie') ? 'missing-origin' : undefined
}

// Elysia picks its body parser from `content-type`, and parses nothing without one. So refusing every
// other declared type leaves JSON as the only body a route can receive: no HTML form (urlencoded,
// multipart, text/plain) can reach a handler. A route-level `parse: 'json'` would not do this: it
// forces the JSON parser whatever the type, turning a form post into a 400 after reading the body.
function isJsonOrAbsent(contentType: string | null): boolean {
  if (contentType === null) return true
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json'
}

// CSRF guard for every state-changing route outside `/api/auth/*` (API.md §1). Web and API share one
// origin (DEC-020), so a request a page of ours made is `Sec-Fetch-Site: same-origin`, or, from a
// browser without Fetch Metadata, carries `Origin: WEB_URL`. `SameSite=Lax` alone lets a sibling
// subdomain post with the session cookie; this does not. Mounted once in `app.ts`, before the modules.
//
// `onRequest` runs before routing, body parsing and the `permission` macro, so a refused request is
// never read, never authenticated and never reaches a service. The cost is that its `http.request`
// is logged under `[unmatched]` with module `core`: the route is not known yet.
export const csrfGuard = new Elysia({ name: 'csrf' }).onRequest(({ request }) => {
  if (SAFE_METHODS.has(request.method)) return
  if (new URL(request.url).pathname.startsWith(AUTH_PATH_PREFIX)) return

  const reason = rejectReason(request.headers)
  if (reason !== undefined) {
    telemetry.emit('audit.csrf.rejected', { method: request.method, reason })
    throw status(403, CSRF_REJECTED)
  }
  if (!isJsonOrAbsent(request.headers.get('content-type'))) throw status(415, UNSUPPORTED_MEDIA_TYPE)
})
