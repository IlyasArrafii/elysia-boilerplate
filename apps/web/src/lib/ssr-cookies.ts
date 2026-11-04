import { appendResponseHeader, getRequestHeader } from '@tanstack/react-start/server'

// What the bridge reads from and writes to: the incoming page request and the outgoing page response.
export interface CookieBridgeIO {
  requestCookie(): string | undefined
  appendSetCookie(value: string): void
}

interface BridgeRequest {
  url: URL | string
  headers: Headers
  redirect?: RequestRedirect
}

interface BridgeResponse {
  response: Response
  request: { url: URL | string }
}

export interface CookieBridge {
  onRequest(context: BridgeRequest): void
  onResponse(context: BridgeResponse): void
}

// Carries the visitor's session across a server-side call to the API, and the API's answer back to the
// browser (apps/web R13). Both directions are limited to the API origin: the visitor's cookie is never sent
// to any other host, and no other host can set cookies on the visitor. Nothing is stored here; `io` reads the
// current request on every call, so concurrent requests never see each other's cookies.
export function createCookieBridge(apiOrigin: string, io: CookieBridgeIO): CookieBridge {
  const allowed = new URL(apiOrigin).origin
  const isApi = (url: URL | string) => new URL(url).origin === allowed

  return {
    onRequest(context) {
      // Whatever cookie a caller put on the call is dropped: only the visitor's own may reach the API.
      context.headers.delete('cookie')
      // A followed redirect would resend the visitor's cookie to wherever it points, and bring back that host's
      // Set-Cookie. The auth endpoints never redirect a server call, so a 3xx stays an unexpected answer.
      context.redirect = 'manual'
      if (!isApi(context.url)) return
      const cookie = io.requestCookie()
      if (cookie) context.headers.set('cookie', cookie)
    },
    onResponse({ response, request }) {
      if (!isApi(request.url)) return
      // Belt and braces for a fetch that followed a redirect anyway: only an answer from the API itself counts.
      if (response.redirected || (response.url !== '' && !isApi(response.url))) return
      // A refreshed expiry or a cleared stale session must reach the browser, as it would through the proxy.
      for (const value of response.headers.getSetCookie()) io.appendSetCookie(value)
    },
  }
}

// The bridge for the page request being rendered right now, through TanStack Start's request scope. Server only.
export function requestCookieBridge(apiOrigin: string): CookieBridge {
  return createCookieBridge(apiOrigin, {
    requestCookie: () => getRequestHeader('cookie'),
    appendSetCookie: (value) => appendResponseHeader('set-cookie', value),
  })
}
