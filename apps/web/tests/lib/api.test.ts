import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createServerEntry } from '@tanstack/react-start/server'
import { api } from '@/lib/api'
import { ApiError, unwrap } from '@/lib/api-error'
import { apiOrigin } from '@/lib/api-origin'

interface SentRequest {
  url: string
  redirect: RequestRedirect | undefined
  cookie: string | undefined
}

// What the page request saw: the unwrapped result, or the error `unwrap()` threw.
interface PageResult {
  data: unknown
  error: { name: string; status: number; code: string } | null
}

const sent: SentRequest[] = []

// Stands in for the network. It answers like an API (or a proxy in front of it) redirecting elsewhere; a fetch
// following that redirect would call it a second time, for the other host, with the same headers.
function redirectingFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const headers = (init?.headers ?? {}) as Record<string, string>
  sent.push({ url: String(input instanceof Request ? input.url : input), redirect: init?.redirect, cookie: headers.cookie })
  return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } }))
}

// A page request in TanStack Start's request scope, as SSR runs the Eden client with the visitor's cookie forwarded.
// happy-dom's Request drops `Cookie` as a forbidden header; a server-side request carries it, so it is put back.
async function ssrHealthCall(cookie: string): Promise<PageResult> {
  const entry = createServerEntry({
    async fetch() {
      try {
        return Response.json({ data: await unwrap(api.health.get()), error: null })
      } catch (error) {
        const view = error instanceof ApiError ? { name: error.name, status: error.status, code: error.code } : null
        return Response.json({ data: null, error: view ?? { name: String(error), status: -1, code: '' } })
      }
    },
  })
  const request = new Request('http://localhost:3001/')
  Object.defineProperty(request, 'headers', { value: new Headers({ cookie }) })
  const response = await entry.fetch(request)
  return (await response.json()) as PageResult
}

afterEach(() => {
  sent.length = 0
})

describe('api (Eden client)', () => {
  test('never follows a redirect: the forwarded cookie goes to the API only, and the 3xx is an ApiError', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(redirectingFetch as typeof fetch)
    try {
      const page = await ssrHealthCall('app.session_token=abc')

      expect(sent).toEqual([{ url: `${apiOrigin()}/api/health`, redirect: 'manual', cookie: 'app.session_token=abc' }])
      expect(page).toEqual({ data: null, error: { name: 'ApiError', status: 302, code: 'INTERNAL_ERROR' } })
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
