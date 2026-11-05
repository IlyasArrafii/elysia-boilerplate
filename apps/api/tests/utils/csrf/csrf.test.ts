import { beforeEach, describe, expect, test } from 'bun:test'
import { Elysia, t } from 'elysia'
import { env } from '../../../src/env'
import { CSRF_REJECTED, csrfGuard, UNSUPPORTED_MEDIA_TYPE } from '../../../src/utils/csrf'
import { errorHandler } from '../../../src/utils/error'
import { loggerPlugin } from '../../../src/utils/logger/plugin'
import { memory, ORIGIN, requestFrom } from '../../helpers/app'

// The guard on its own, in front of routes that record whether they ran. The posts route tests
// prove the same rules on the real app, against the database.

let handled: string[] = []

const probe = new Elysia({ prefix: '/probe' })
  .get('/', () => {
    handled.push('GET')
    return { ok: true }
  })
  .post(
    '/',
    ({ body }) => {
      handled.push('POST')
      return body
    },
    { body: t.Object({ title: t.String() }) },
  )
  .patch('/', () => {
    handled.push('PATCH')
    return { ok: true }
  })
  .delete('/', () => {
    handled.push('DELETE')
    return { ok: true }
  })

// Stands in for Better Auth's mount: the guard leaves `/api/auth/*` alone.
const fakeAuth = new Elysia({ prefix: '/auth' }).all('/*', () => {
  handled.push('AUTH')
  return { ok: true }
})

const app = new Elysia({ prefix: '/api' }).use(loggerPlugin).use(errorHandler).use(csrfGuard).use(fakeAuth).use(probe)
const send = requestFrom(app)

const COOKIE = 'app.session_token=abc.def'
const JSON_BODY = JSON.stringify({ title: 'Hello' })
const STATE_CHANGING = ['POST', 'PATCH', 'DELETE'] as const

function write(method: string, headers: Record<string, string>, path = '/api/probe'): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON_BODY,
  })
}

async function handle(request: Request): Promise<Response> {
  const response = await app.handle(request)
  await new Promise<void>((resolve) => setImmediate(resolve))
  return response
}

async function expectRejected(request: Request, reason: string): Promise<void> {
  const response = await handle(request)

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual(CSRF_REJECTED)
  expect(response.headers.get('x-request-id')).toBeString()
  // Refused before the body is read and before any route runs.
  expect(request.bodyUsed).toBe(false)
  expect(handled).toEqual([])
  expect(memory.find('audit.csrf.rejected')).toEqual([
    expect.objectContaining({ kind: 'audit', level: 'warn', method: request.method, reason }),
  ])
  expect(memory.find('http.error')).toEqual([expect.objectContaining({ status: 403, code: 'CSRF_REJECTED' })])
  // Refused before routing, yet the three lines still share the response's request id.
  const requestId = response.headers.get('x-request-id')
  for (const event of ['audit.csrf.rejected', 'http.error', 'http.request']) {
    expect(memory.find(event)).toEqual([expect.objectContaining({ requestId })])
  }
  expect(memory.find('http.request')).toEqual([expect.objectContaining({ status: 403, route: '[unmatched]', module: 'core' })])
}

beforeEach(() => {
  handled = []
  memory.clear()
})

describe('refused: 403 CSRF_REJECTED', () => {
  test.each(STATE_CHANGING)('%s with Sec-Fetch-Site: cross-site', async (method) => {
    await expectRejected(write(method, { 'sec-fetch-site': 'cross-site', cookie: COOKIE }), 'cross-site')
  })

  // A sibling subdomain: SameSite=Lax would still send the cookie.
  test.each(STATE_CHANGING)('%s with Sec-Fetch-Site: same-site', async (method) => {
    await expectRejected(write(method, { 'sec-fetch-site': 'same-site', cookie: COOKIE }), 'same-site')
  })

  test.each(STATE_CHANGING)('%s with a foreign Origin and no Fetch Metadata', async (method) => {
    await expectRejected(write(method, { origin: 'https://evil.example', cookie: COOKIE }), 'foreign-origin')
  })

  test('an unknown Sec-Fetch-Site value counts as cross-site', async () => {
    await expectRejected(write('POST', { 'sec-fetch-site': 'bogus' }), 'cross-site')
  })

  // Fetch Metadata wins: a browser that sends it computed it, whatever the Origin says.
  test('Sec-Fetch-Site: cross-site with the trusted Origin', async () => {
    await expectRejected(write('POST', { 'sec-fetch-site': 'cross-site', origin: env.WEB_URL }), 'cross-site')
  })

  test('Origin: null (sandboxed frame, privacy redirect)', async () => {
    await expectRejected(write('POST', { origin: 'null', cookie: COOKIE }), 'foreign-origin')
  })

  test('an Origin that only differs by port, scheme or subdomain', async () => {
    const trusted = new URL(env.WEB_URL)
    const lookalikes = [
      `${trusted.protocol}//${trusted.hostname}:9`,
      `${trusted.protocol === 'https:' ? 'http:' : 'https:'}//${trusted.host}`,
      `${trusted.protocol}//api.${trusted.host}`,
      `${env.WEB_URL}/`,
    ]
    for (const origin of lookalikes) {
      memory.clear()
      await expectRejected(write('POST', { origin }), 'foreign-origin')
    }
  })

  test('a cookie with neither Origin nor Sec-Fetch-Site', async () => {
    await expectRejected(write('POST', { cookie: COOKIE }), 'missing-origin')
  })

  // Fetch normalizes only DELETE, GET, HEAD, OPTIONS, POST and PUT: `patch` keeps its case.
  test('a lowercase method is still checked', async () => {
    await expectRejected(write('patch', { 'sec-fetch-site': 'cross-site' }), 'cross-site')
  })

  test('a path outside /api/auth/* that only starts like it', async () => {
    await expectRejected(write('POST', { 'sec-fetch-site': 'cross-site' }, '/api/authx'), 'cross-site')
  })

  // Bun resolves dot segments (`%2e%2e` too) in `request.url` before `onRequest`, and Elysia routes on
  // that same path: a request that climbs out of `/api/auth/` is checked as the route it lands on.
  test.each(['/api/auth/../probe', '/api/auth/%2e%2e/probe', '/api/auth/x/../../probe'])(
    '%s climbs out of /api/auth/ and is checked',
    async (path) => {
      await expectRejected(write('POST', { 'sec-fetch-site': 'cross-site' }, path), 'cross-site')
    },
  )

  // An encoded separator is not a separator: the path stays inside the auth mount for both the guard
  // and the router, so it can never reach another module's handler.
  test('an encoded separator after /api/auth/ stays on the auth mount', async () => {
    const response = await handle(write('POST', { 'sec-fetch-site': 'cross-site' }, '/api/auth/..%2fprobe'))

    expect(response.status).toBe(200)
    expect(handled).toEqual(['AUTH'])
  })

  test('an encoded separator before it is not the auth mount', async () => {
    await expectRejected(write('POST', { 'sec-fetch-site': 'cross-site' }, '/api/auth%2f../probe'), 'cross-site')
  })

  test('the event carries no header, cookie or URL', async () => {
    await handle(write('POST', { origin: 'https://evil.example', cookie: COOKIE }, '/api/probe?token=SECRET'))

    const logged = JSON.stringify(memory.lines)
    for (const leak of ['evil.example', 'abc.def', 'session_token', 'SECRET', '/api/probe']) expect(logged).not.toContain(leak)
  })
})

describe('allowed', () => {
  test.each(STATE_CHANGING)('%s with Sec-Fetch-Site: same-origin', async (method) => {
    const response = await handle(write(method, { 'sec-fetch-site': 'same-origin', cookie: COOKIE }))

    expect(response.status).toBe(200)
    expect(handled).toEqual([method])
    expect(memory.find('audit.csrf.rejected')).toEqual([])
  })

  test.each(STATE_CHANGING)('%s with the trusted Origin', async (method) => {
    const response = await handle(write(method, { origin: env.WEB_URL, cookie: COOKIE }))

    expect(response.status).toBe(200)
    expect(handled).toEqual([method])
  })

  // Deliberate (decided design): Fetch Metadata is computed by the browser, so when it says
  // same-origin the Origin header is not cross-checked, even a foreign one or `null`.
  test.each(['https://evil.example', 'null'])('Sec-Fetch-Site: same-origin with Origin %s', async (origin) => {
    const response = await handle(write('POST', { 'sec-fetch-site': 'same-origin', origin, cookie: COOKIE }))

    expect(response.status).toBe(200)
    expect(handled).toEqual(['POST'])
  })

  test('Sec-Fetch-Site: none (a request the user started)', async () => {
    expect((await handle(write('POST', { 'sec-fetch-site': 'none', cookie: COOKIE }))).status).toBe(200)
  })

  // A non-browser client without a session: it reaches the route, which answers as usual (401 on a
  // protected one).
  test('no cookie, no Origin and no Sec-Fetch-Site', async () => {
    const response = await handle(write('POST', {}))

    expect(response.status).toBe(200)
    expect(handled).toEqual(['POST'])
  })

  test.each(['GET', 'HEAD', 'OPTIONS'])('%s is never checked', async (method) => {
    const response = await send('/api/probe', { method, headers: { 'sec-fetch-site': 'cross-site', cookie: COOKIE } })

    expect(response.status).not.toBe(403)
    expect(memory.find('audit.csrf.rejected')).toEqual([])
  })

  test('/api/auth/* is left to Better Auth, whatever the headers or body type', async () => {
    const response = await send('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', cookie: COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a%40b.c',
    })

    expect(response.status).toBe(200)
    expect(handled).toEqual(['AUTH'])
  })
})

describe('JSON-only bodies: 415 UNSUPPORTED_MEDIA_TYPE', () => {
  const sameOrigin = { origin: env.WEB_URL, cookie: COOKIE }
  const forms: [string, () => RequestInit][] = [
    ['application/x-www-form-urlencoded', () => ({ headers: { ...sameOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=Hello' })],
    [
      'multipart/form-data',
      () => {
        const form = new FormData()
        form.set('title', 'Hello')
        return { headers: sameOrigin, body: form }
      },
    ],
    ['text/plain', () => ({ headers: { ...sameOrigin, 'content-type': 'text/plain;charset=UTF-8' }, body: JSON_BODY })],
  ]

  test.each(forms)('%s is refused without being parsed', async (_type, init) => {
    const request = new Request(`${ORIGIN}/api/probe`, { method: 'POST', ...init() })

    const response = await handle(request)

    expect(response.status).toBe(415)
    expect(await response.json()).toEqual(UNSUPPORTED_MEDIA_TYPE)
    expect(request.bodyUsed).toBe(false)
    expect(handled).toEqual([])
    expect(memory.find('http.error')).toEqual([expect.objectContaining({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })])
  })

  // The CSRF check comes first: a cross-site form is a 403, not a 415.
  test('a cross-site form is 403', async () => {
    const response = await send('/api/probe', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=Hello',
    })

    expect(response.status).toBe(403)
  })

  test.each(['application/json', 'application/json; charset=utf-8'])('%s is accepted', async (type) => {
    const response = await send('/api/probe', { method: 'POST', headers: { ...sameOrigin, 'content-type': type }, body: JSON_BODY })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ title: 'Hello' })
  })

  // Media types are case-insensitive, so the guard lets it through; Elysia 1.4.30 matches its parsers
  // case-sensitively and parses nothing, so the route's validation answers.
  test('Application/JSON passes the guard and fails validation', async () => {
    const response = await send('/api/probe', {
      method: 'POST',
      headers: { ...sameOrigin, 'content-type': 'Application/JSON' },
      body: JSON_BODY,
    })

    expect(response.status).toBe(400)
    expect(handled).toEqual([])
  })

  // Elysia parses no body without a content-type, so there is nothing to refuse (DELETE has none).
  test('no content-type passes the guard', async () => {
    const response = await send('/api/probe', { method: 'DELETE', headers: sameOrigin })

    expect(response.status).toBe(200)
    expect(handled).toEqual(['DELETE'])
  })

  // The assumption behind letting an absent content-type through: Elysia does not read such a body,
  // so a body route sees nothing and its validation refuses it.
  test('a POST with bytes but no content-type is never parsed', async () => {
    const request = new Request(`${ORIGIN}/api/probe`, {
      method: 'POST',
      headers: sameOrigin,
      body: new TextEncoder().encode(JSON_BODY),
    })
    expect(request.headers.has('content-type')).toBe(false)

    const response = await handle(request)

    expect(response.status).toBe(400)
    expect(request.bodyUsed).toBe(false)
    expect(handled).toEqual([])
  })
})
