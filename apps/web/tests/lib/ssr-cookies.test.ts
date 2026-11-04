import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { createServerEntry, getRequestHeader, getResponseHeaders } from '@tanstack/react-start/server'
import { createAuthClient } from 'better-auth/react'
import { createCookieBridge, requestCookieBridge } from '@/lib/ssr-cookies'

const API = 'http://api.internal:3000'

function bridgeWith(cookie: string | undefined) {
  const appended: string[] = []
  const bridge = createCookieBridge(API, { requestCookie: () => cookie, appendSetCookie: (value) => appended.push(value) })
  return { bridge, appended }
}

// happy-dom's Response drops `Set-Cookie` given to its constructor (a browser hides it), which would make a
// "nothing forwarded" assertion pass vacuously; appending afterwards keeps it, as a server's response would.
function attackerResponse(): Response {
  const response = new Response(null)
  response.headers.append('set-cookie', 'app.session_token=attacker; Path=/')
  return response
}

describe('createCookieBridge', () => {
  test('forwards the visitor cookie to the API', () => {
    const { bridge } = bridgeWith('app.session_token=abc')
    const headers = new Headers()

    bridge.onRequest({ url: `${API}/api/auth/get-session`, headers })

    expect(headers.get('cookie')).toBe('app.session_token=abc')
  })

  test('never sends the visitor cookie to another origin, and drops any cookie set on such a call', () => {
    const { bridge } = bridgeWith('app.session_token=abc')
    const headers = new Headers({ cookie: 'planted=1' })

    bridge.onRequest({ url: 'https://evil.example/api/auth/get-session', headers })

    expect(headers.get('cookie')).toBeNull()
  })

  test('a guest request carries no cookie, even if the caller set one', () => {
    const { bridge } = bridgeWith(undefined)
    const headers = new Headers({ cookie: 'someone-else=1' })

    bridge.onRequest({ url: new URL(`${API}/api/auth/get-session`), headers })

    expect(headers.get('cookie')).toBeNull()
  })

  test('passes every Set-Cookie from the API on to the page response', () => {
    const { bridge, appended } = bridgeWith('x=1')
    const response = new Response(null)
    response.headers.append('set-cookie', 'app.session_token=abc; Path=/; HttpOnly; SameSite=Lax')
    response.headers.append('set-cookie', 'app.session_data=; Max-Age=0; Path=/')

    bridge.onResponse({ response, request: { url: `${API}/api/auth/get-session` } })

    expect(appended).toEqual(['app.session_token=abc; Path=/; HttpOnly; SameSite=Lax', 'app.session_data=; Max-Age=0; Path=/'])
  })

  test('ignores Set-Cookie from any other origin', () => {
    const { bridge, appended } = bridgeWith('x=1')
    const response = attackerResponse()

    bridge.onResponse({ response, request: { url: 'https://evil.example/' } })

    expect(appended).toEqual([])
  })

  test('tells fetch not to follow redirects, for the API and any other origin', () => {
    const { bridge } = bridgeWith('app.session_token=abc')
    const toApi = { url: `${API}/api/auth/get-session`, headers: new Headers() }
    const elsewhere = { url: 'https://evil.example/', headers: new Headers() }

    bridge.onRequest(toApi)
    bridge.onRequest(elsewhere)

    expect(toApi).toMatchObject({ redirect: 'manual' })
    expect(elsewhere).toMatchObject({ redirect: 'manual' })
  })

  test.each([
    ['a followed redirect', true, 'https://evil.example/landing'],
    ['a final URL on another origin', false, 'https://evil.example/landing'],
    ['a followed redirect back to the API', true, `${API}/api/auth/get-session`],
  ])('ignores Set-Cookie on an API call that ended with %s', (_, redirected, finalUrl) => {
    const { bridge, appended } = bridgeWith('x=1')
    const response = attackerResponse()
    Object.defineProperty(response, 'redirected', { value: redirected })
    Object.defineProperty(response, 'url', { value: finalUrl })

    bridge.onResponse({ response, request: { url: `${API}/api/auth/get-session` } })

    expect(appended).toEqual([])
  })
})

// The real wiring of src/lib/auth-client.ts: Better Auth's client with `requestCookieBridge`, inside TanStack Start's
// request scope, against a stand-in API that answers get-session from the cookie it receives.
describe('requestCookieBridge in a real SSR request scope', () => {
  const USERS: Record<string, string> = { alice: 'alice@example.test', bob: 'bob@example.test' }
  const received: Array<{ id: string | null; cookie: string | null }> = []
  let entry: { fetch: (request: Request) => Promise<Response> | Response }

  // happy-dom's Response is the browser's, which hides `Set-Cookie`; the API's response to a server carries it.
  function apiResponse(body: unknown, setCookie?: string): Response {
    const response = Response.json(body)
    const headers = new Headers({ 'content-type': 'application/json' })
    if (setCookie) headers.append('set-cookie', setCookie)
    Object.defineProperty(response, 'headers', { value: headers })
    return response
  }

  // The API, as the network call reaches it: after the bridge's `onRequest` has set (or not set) the Cookie header.
  // It runs inside the page request's scope, so it can tell which page request a call belongs to.
  async function api(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const cookie = new Headers(init?.headers).get('cookie')
    received.push({ id: getRequestHeader('x-page-request') ?? null, cookie })
    // Answer out of order, so concurrent page requests interleave.
    await Bun.sleep(Math.floor(Math.random() * 15))
    expect(new URL(String(input instanceof Request ? input.url : input)).origin).toBe(API)
    const token = /app\.session_token=([a-z]+)/.exec(cookie ?? '')?.[1]
    const email = token ? USERS[token] : undefined
    // A stale session: Better Auth answers null and clears the cookie.
    if (token && !email) return apiResponse(null, 'app.session_token=; Max-Age=0; Path=/; HttpOnly')
    if (!email) return apiResponse(null)
    const body = { user: { id: `usr_${token}`, email, name: token }, session: { id: `ses_${token}`, token, userId: `usr_${token}` } }
    // A session past `updateAge` gets its expiry refreshed.
    return apiResponse(body, `app.session_token=${token}; Max-Age=604800; Path=/; HttpOnly`)
  }

  beforeAll(() => {
    // One client for every request, like the module-level `authClient`.
    const client = createAuthClient({ baseURL: API, fetchOptions: { ...requestCookieBridge(API), customFetchImpl: api } })
    entry = createServerEntry({
      async fetch() {
        const { data, error } = await client.getSession()
        return Response.json({ email: data?.user.email ?? null, error, setCookies: getResponseHeaders().getSetCookie() })
      },
    })
  })

  // A page request as the web server receives it. happy-dom (preloaded for every web test) implements the browser's
  // Request, which drops `Cookie` as a forbidden header; a server-side request carries it, so it is put back.
  function pageRequest(id: string, cookie?: string) {
    const headers = new Headers({ 'x-page-request': id })
    if (cookie) headers.set('cookie', `theme=dark; ${cookie}`)
    const request = new Request(`http://localhost:3001/access?r=${id}`)
    Object.defineProperty(request, 'headers', { value: headers })
    return Promise.resolve(entry.fetch(request)).then(
      (response) => response.json() as Promise<{ email: string | null; setCookies: string[] }>,
    )
  }

  test('concurrent page requests each read their own session, and a guest none', async () => {
    received.length = 0

    const pages = await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const who = ['alice', 'bob', 'guest'][index % 3] as 'alice' | 'bob' | 'guest'
        return pageRequest(`${who}-${index}`, who === 'guest' ? undefined : `app.session_token=${who}`).then((page) => ({ who, page }))
      }),
    )

    for (const { who, page } of pages) {
      expect(page.email).toBe(who === 'guest' ? null : (USERS[who] ?? 'missing'))
    }
    // What the API actually received, per page request: exactly that request's Cookie header, or none.
    for (const { id, cookie } of received) {
      if (id?.startsWith('guest')) expect(cookie).toBeNull()
      else expect(cookie).toBe(`theme=dark; app.session_token=${id?.split('-')[0]}`)
    }
    expect(received).toHaveLength(12)
  })

  test('a refreshed session cookie from the API is set on that page response only', async () => {
    const [alice, guest] = await Promise.all([pageRequest('alice-refresh', 'app.session_token=alice'), pageRequest('guest-refresh')])

    expect(alice.setCookies).toEqual(['app.session_token=alice; Max-Age=604800; Path=/; HttpOnly'])
    expect(guest.setCookies).toEqual([])
  })

  test('a stale session is cleared in the browser through the page response', async () => {
    const page = await pageRequest('stale', 'app.session_token=revoked')

    expect(page.email).toBeNull()
    expect(page.setCookies).toEqual(['app.session_token=; Max-Age=0; Path=/; HttpOnly'])
  })

  test('an API redirect to another host is not followed: no cookie leaves, none comes back, the check fails', async () => {
    const evilReceived: Array<string | null> = []
    // A fetch with the platform's redirect semantics, against an API that answers with a 302 to another host.
    async function redirectingApi(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const location = 'https://evil.example/collect'
      if (init?.redirect === 'manual') return new Response(null, { status: 302, headers: { location } })
      evilReceived.push(new Headers(init?.headers).get('cookie'))
      const response = apiResponse({ user: { id: 'usr_evil', email: 'evil@example.test', name: 'evil' } }, 'app.session_token=attacker; Path=/')
      Object.defineProperty(response, 'redirected', { value: true })
      Object.defineProperty(response, 'url', { value: location })
      return response
    }
    const client = createAuthClient({ baseURL: API, fetchOptions: { ...requestCookieBridge(API), customFetchImpl: redirectingApi } })
    const redirectEntry = createServerEntry({
      async fetch() {
        const { data, error } = await client.getSession()
        return Response.json({ email: data?.user.email ?? null, status: error?.status ?? null, setCookies: getResponseHeaders().getSetCookie() })
      },
    })
    const headers = new Headers({ cookie: 'app.session_token=alice' })
    const request = new Request('http://localhost:3001/access')
    Object.defineProperty(request, 'headers', { value: headers })

    const page = (await (await redirectEntry.fetch(request)).json()) as { email: string | null; status: number | null; setCookies: string[] }

    expect(evilReceived).toEqual([])
    expect(page).toEqual({ email: null, status: 302, setCookies: [] })
  })

  test('outside a request scope there is no cookie to borrow: the call fails instead of guessing', async () => {
    const fetchSpy = mock(fetch)
    const client = createAuthClient({ baseURL: API, fetchOptions: { ...requestCookieBridge(API), customFetchImpl: fetchSpy } })

    await expect(client.getSession()).rejects.toThrow('No StartEvent found')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
