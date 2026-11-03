import { describe, expect, test } from 'bun:test'
import { CookieJar, e2eBaseUrl } from '../e2e/helpers/client'

function withCookies(...cookies: string[]): Response {
  const headers = new Headers()
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { headers })
}

describe('E2E client', () => {
  test('requires API_E2E_URL and drops a trailing slash', () => {
    expect(() => e2eBaseUrl({})).toThrow('API_E2E_URL is not set')
    expect(() => e2eBaseUrl({ API_E2E_URL: 'not a url' })).toThrow('API_E2E_URL must be')
    expect(e2eBaseUrl({ API_E2E_URL: 'http://localhost:3010/' })).toBe('http://localhost:3010')
  })

  test('the cookie jar keeps, replaces and expires cookies by name', () => {
    const jar = new CookieJar()
    expect(jar.header()).toBeUndefined()

    jar.store(withCookies('app.session_token=abc.def; Path=/; HttpOnly; SameSite=Lax', 'other=1; Max-Age=60'))
    expect(jar.header()).toBe('app.session_token=abc.def; other=1')

    jar.store(withCookies('app.session_token=xyz; Path=/'))
    expect(jar.get('app.session_token')).toBe('xyz')

    jar.store(withCookies('app.session_token=; Max-Age=0', 'other=; Expires=Thu, 01 Jan 1970 00:00:00 GMT'))
    expect(jar.header()).toBeUndefined()
  })
})
